// Support-ticket attachment storage. Uploads (base64 from the client — pasted or
// chosen screenshots/files) are streamed through the Lambda to a PRIVATE S3
// bucket. Objects are never public; they're served via short-lived presigned GET
// URLs minted on read, so a leaked/stale URL expires quickly.
// @aws-sdk/client-s3 ships with the nodejs20 runtime (externalised by the
// bundler); the presigner is bundled (see scripts/build.mjs).
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});
const BUCKET = process.env.ATTACHMENTS_BUCKET;
const BROADCAST_BUCKET = process.env.BROADCAST_IMAGES_BUCKET;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB cap
const URL_TTL = 600; // presigned GET validity (seconds)

// Broadcast images are world-readable (an email client fetches the <img> by URL
// long after the presigned TTL would expire), so they live in a separate PUBLIC
// bucket and only these image types are accepted — nothing sensitive belongs here.
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'text/plain': 'txt',
};

/** A short-lived presigned GET URL for a stored attachment key. */
export async function signAttachmentUrl(key) {
  if (!BUCKET || !key) return null;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: URL_TTL });
}

/**
 * Store one attachment. `dataBase64` may be a raw base64 string or a data URL.
 * Returns { key, url, name, contentType, size } — `key` is persisted on the
 * ticket; `url` is a presigned GET for immediate preview (re-signed on read).
 */
export async function putAttachment({ userId, name, contentType, dataBase64 }) {
  if (!BUCKET) throw new Error('Attachments are not configured on this deployment.');
  let b64 = dataBase64 || '';
  const m = b64.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) { contentType = contentType || m[1]; b64 = m[2]; }
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('Empty attachment.');
  if (buf.length > MAX_BYTES) throw new Error('Attachment exceeds 8MB.');
  const ct = contentType || 'application/octet-stream';
  const ext = EXT[ct] || (name && name.includes('.') ? name.split('.').pop().slice(0, 5) : 'bin');
  const key = `attachments/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: ct }));
  return {
    key,
    url: await signAttachmentUrl(key),
    name: name || key.split('/').pop(),
    contentType: ct,
    size: buf.length,
  };
}

/**
 * Store a broadcast image (admin-uploaded) in the PUBLIC broadcast-images bucket
 * and return a durable public URL — usable directly as an email `<img>` src and
 * in the in-app bell. Images only; the bucket is world-readable. `dataBase64`
 * may be a raw base64 string or a data URL.
 */
export async function putBroadcastImage({ name, contentType, dataBase64 }) {
  if (!BROADCAST_BUCKET) throw new Error('Broadcast images are not configured on this deployment.');
  let b64 = dataBase64 || '';
  const m = b64.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) { contentType = contentType || m[1]; b64 = m[2]; }
  const ct = String(contentType || '').toLowerCase();
  const ext = IMG_EXT[ct];
  if (!ext) throw new Error('Only PNG, JPEG, GIF, or WebP images are allowed.');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('Empty image.');
  if (buf.length > MAX_BYTES) throw new Error('Image exceeds 8MB.');
  const key = `broadcasts/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: BROADCAST_BUCKET, Key: key, Body: buf, ContentType: ct,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  const region = process.env.AWS_REGION || 'ap-southeast-1';
  return { key, url: `https://${BROADCAST_BUCKET}.s3.${region}.amazonaws.com/${key}`, contentType: ct, size: buf.length };
}

/** Delete every attachment a user owns (account erasure). Best-effort. */
export async function deleteUserAttachments(userId) {
  if (!BUCKET) return;
  let ContinuationToken;
  do {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `attachments/${userId}/`, ContinuationToken }));
    const objects = (list.Contents || []).map((o) => ({ Key: o.Key }));
    if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects } }));
    ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

/**
 * Refresh every attachment URL on a ticket's message thread with a freshly
 * signed GET (the stored `url` is stale/expired). Mutates and returns the ticket.
 * Legacy attachments with no `key` (pre-private-bucket) keep their stored url.
 */
export async function signTicketAttachments(ticket) {
  if (!ticket?.messages) return ticket;
  for (const msg of ticket.messages) {
    for (const att of (msg.attachments || [])) {
      if (att.key) att.url = await signAttachmentUrl(att.key);
    }
  }
  return ticket;
}
