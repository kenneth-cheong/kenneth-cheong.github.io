// Support-ticket attachment storage. Uploads (base64 from the client — pasted or
// chosen screenshots/files) are streamed through the Lambda to S3 and served
// from unguessable public-read keys. @aws-sdk/client-s3 ships with the nodejs20
// Lambda runtime (externalised by the bundler).
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const BUCKET = process.env.ATTACHMENTS_BUCKET;
const REGION = process.env.AWS_REGION || 'ap-southeast-1';
const MAX_BYTES = 8 * 1024 * 1024; // 8MB cap

const EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'text/plain': 'txt',
};

/**
 * Store one attachment. `dataBase64` may be a raw base64 string or a data URL.
 * Returns { url, name, contentType, size }.
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
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: buf, ContentType: ct,
    CacheControl: 'public, max-age=31536000',
  }));
  return {
    url: `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`,
    name: name || key.split('/').pop(),
    contentType: ct,
    size: buf.length,
  };
}
