// Turn a user-picked image file into a base64 data URL the vision model can read.
//
// Everything here exists because sending the raw file is wrong in three separate
// ways: it's far larger than the model can use, it may be a format the model
// can't read, and transparency silently ruins the result.

// Haiku 4.5 downsamples the image before it looks at it, so shipping more pixels
// than it will keep buys nothing — just a bigger, slower request. TWO limits
// apply and the second is the one that usually binds:
//
//   • the longest edge is capped at 1568px
//   • an image costs roughly (width × height) / 750 tokens, capped at ~1600 —
//     i.e. about 1.15 megapixels
//
// Only a near-square image hits 1568px before it hits 1.15MP. A 3:2 photo scaled
// to a 1568px long edge is 1.64MP ≈ 2185 tokens, so a third of what we upload
// gets thrown away on arrival. Enforce both.
// (The 2576px high-resolution path is Opus 4.7+ / Sonnet 5 only; caption runs on Haiku.)
const MAX_EDGE = 1568;
const MAX_PIXELS = 1_150_000;
const PIXELS_PER_TOKEN = 750;
const QUALITY = 0.82;
// A generous ceiling on what we'll even open. Past this it's a phone's raw
// burst or a mistake, and decoding it just to throw the pixels away is a way to
// hang a laptop.
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/**
 * Read one image file and return `{ name, dataUrl, width, height }`, downscaled
 * and re-encoded as JPEG. Throws with a human-readable message.
 */
export async function fileToVisionImage(file) {
  if (!file.type?.startsWith('image/')) {
    throw new Error('that file isn’t an image');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`it’s ${(file.size / 1048576).toFixed(1)} MB — please pick something under 25 MB`);
  }

  const bitmap = await decode(file);
  try {
    const scale = Math.min(
      1,
      MAX_EDGE / Math.max(bitmap.width, bitmap.height),
      Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Flatten transparency onto MID-GREY, not white. JPEG has no alpha channel,
    // so a transparent PNG has to land on something — and the web is full of
    // white logos and white product cut-outs on transparency. Composited onto
    // white those become a genuinely blank image, and the model correctly
    // reports seeing nothing. Mid-grey keeps both white and dark artwork legible.
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
    if (!dataUrl.startsWith('data:image/jpeg')) throw new Error('the browser couldn’t re-encode it');
    return { name: file.name, dataUrl, width, height };
  } finally {
    bitmap.close?.();
  }
}

/** Rough token cost of an image, for showing the user what a run will spend. */
export function imageTokens({ width, height }) {
  return Math.ceil((width * height) / PIXELS_PER_TOKEN);
}

// createImageBitmap is the fast path and handles orientation, but Safari has
// historically been patchy on some formats — fall back to a plain <img> decode.
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch { /* fall through to the <img> path */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('the file looks corrupt or isn’t a supported image'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
