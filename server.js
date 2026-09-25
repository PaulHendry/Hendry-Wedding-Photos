import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import QRCode from "qrcode";

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  EVENT_CODE,
  ADMIN_PASSWORD,
  COUPLE_NAMES = "Our wedding",
  WEDDING_DATE = "",
  WEDDING_PLACE = "",
  PUBLIC_URL = "",
  PORT = 3000,
} = process.env;

const missing = Object.entries({
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, EVENT_CODE, ADMIN_PASSWORD,
}).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  // Newer SDK versions add checksum headers to presigned PUTs, which breaks browser uploads to R2.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const MAX_PHOTO_BYTES = 30 * 1024 * 1024;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/gif": "gif",
};
const KEY_RE = /^photos\/(\d{16}-[a-f0-9]{8})\.(jpg|png|webp|heic|heif|gif)$/;
const VIEW_TTL = 6 * 60 * 60; // gallery links last 6 hours
const UPLOAD_TTL = 15 * 60;

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function guest(req, res, next) {
  const code = req.get("x-event-code") || req.query.c;
  if (!safeEqual(code, EVENT_CODE)) return res.status(401).json({ error: "bad_code" });
  next();
}

function admin(req, res, next) {
  if (!safeEqual(req.get("x-admin-password"), ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "bad_password" });
  }
  next();
}

// Simple per-IP limit so a leaked link can't be hammered. 400 uploads per 10 minutes is plenty for a guest.
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const entry = hits.get(req.ip) || { count: 0, reset: now + 10 * 60 * 1000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 10 * 60 * 1000; }
  entry.count++;
  hits.set(req.ip, entry);
  if (entry.count > 400) return res.status(429).json({ error: "slow_down" });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now > e.reset) hits.delete(ip);
}, 60 * 1000).unref();

// Reverse timestamp so the newest photos list first.
const newId = () =>
  `${String(9e15 - Date.now()).padStart(16, "0")}-${crypto.randomBytes(4).toString("hex")}`;

const viewUrl = (Key, extra = {}) =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: R2_BUCKET, Key, ...extra }), { expiresIn: VIEW_TTL });

app.get("/api/config", (req, res) => {
  res.json({ names: COUPLE_NAMES, date: WEDDING_DATE, place: WEDDING_PLACE });
});

app.get("/api/check", guest, (req, res) => res.json({ ok: true }));

app.post("/api/uploads", guest, rateLimit, async (req, res) => {
  const { contentType, size, thumbSize } = req.body || {};
  const ext = EXT[contentType];
  if (!ext) return res.status(400).json({ error: "not_a_photo" });
  if (!Number.isInteger(size) || size <= 0 || size > MAX_PHOTO_BYTES) {
    return res.status(400).json({ error: "too_big" });
  }
  const id = newId();
  const key = `photos/${id}.${ext}`;
  try {
    const photoUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType, ContentLength: size }),
      { expiresIn: UPLOAD_TTL }
    );
    let thumbUrl = null;
    if (Number.isInteger(thumbSize) && thumbSize > 0 && thumbSize <= MAX_THUMB_BYTES) {
      thumbUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: R2_BUCKET, Key: `thumbs/${id}.jpg`, ContentType: "image/jpeg", ContentLength: thumbSize }),
        { expiresIn: UPLOAD_TTL }
      );
    }
    res.json({ id, key, photoUrl, thumbUrl });
  } catch (err) {
    console.error("presign failed", err);
    res.status(500).json({ error: "server" });
  }
});

app.get("/api/photos", guest, async (req, res) => {
  try {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: "photos/",
      MaxKeys: 60,
      ContinuationToken: req.query.cursor || undefined,
    }));
    const photos = await Promise.all((out.Contents || []).map(async (obj) => {
      const m = KEY_RE.exec(obj.Key);
      if (!m) return null;
      const [, id] = m;
      return {
        id,
        key: obj.Key,
        thumb: await viewUrl(`thumbs/${id}.jpg`),
        full: await viewUrl(obj.Key),
      };
    }));
    res.json({ photos: photos.filter(Boolean), next: out.IsTruncated ? out.NextContinuationToken : null });
  } catch (err) {
    console.error("list failed", err);
    res.status(500).json({ error: "server" });
  }
});

app.get("/api/download", guest, async (req, res) => {
  const key = String(req.query.key || "");
  const m = KEY_RE.exec(key);
  if (!m) return res.status(400).send("Bad photo");
  const url = await viewUrl(key, {
    ResponseContentDisposition: `attachment; filename="wedding-${m[1]}.${m[2]}"`,
  });
  res.redirect(302, url);
});

app.delete("/api/admin/photos", admin, async (req, res) => {
  const key = String(req.query.key || "");
  const m = KEY_RE.exec(key);
  if (!m) return res.status(400).json({ error: "bad_key" });
  try {
    await s3.send(new DeleteObjectsCommand({
      Bucket: R2_BUCKET,
      Delete: { Objects: [{ Key: key }, { Key: `thumbs/${m[1]}.jpg` }] },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error("delete failed", err);
    res.status(500).json({ error: "server" });
  }
});

app.get("/api/admin/overview", admin, async (req, res) => {
  try {
    let count = 0, bytes = 0, token;
    do {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: "photos/", ContinuationToken: token }));
      for (const o of out.Contents || []) { count++; bytes += o.Size || 0; }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    const base = (PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const guestLink = `${base}/?c=${encodeURIComponent(EVENT_CODE)}`;
    const qr = await QRCode.toDataURL(guestLink, { width: 1200, margin: 2, errorCorrectionLevel: "M" });
    res.json({ count, bytes, guestLink, qr });
  } catch (err) {
    console.error("overview failed", err);
    res.status(500).json({ error: "server" });
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Wedding photos running on port ${PORT}`));
