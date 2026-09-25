[README.md](https://github.com/user-attachments/files/32664487/README.md)
# Hendry-Wedding-Photos
A place for all of our guests to upload their photos from our day to. 
# Wedding photos

Guests scan a QR code, upload photos straight from their phone, and see everyone else's. No app, no sign-in. Photos are stored at full quality in Cloudflare R2. The app itself runs on Render.

How it fits together: the Render app never touches the photo files. When a guest picks photos, their phone asks the app for a one-time upload link and sends the photo directly to R2. That keeps uploads fast and means the app can run on Render's smallest paid plan.

## 1. Set up Cloudflare R2 (about 10 minutes)

1. Sign up at dash.cloudflare.com and open **R2 Object Storage**. You'll need to add a card, but 10GB is free.
2. **Create bucket**. Name it something like `wedding-photos`. Location: pick Western Europe as the hint.
3. Leave the bucket private. Guests only ever get time-limited links.
4. In the bucket, go to **Settings > CORS Policy** and paste this, swapping in your Render URL once you have it (step 2):

```json
[
  {
    "AllowedOrigins": ["https://YOUR-APP.onrender.com"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

If you add a custom domain later, add it to `AllowedOrigins` too. Uploads fail silently in the browser without this, so it's the first thing to check if something breaks.

5. Back on the R2 overview page, **Manage API tokens > Create API token**. Permission: **Object Read & Write**, scoped to your bucket only. Save the **Access Key ID** and **Secret Access Key** (you only see the secret once). Your **Account ID** is on the R2 overview page.

## 2. Deploy on Render

1. Push this folder to a GitHub repo (private is fine).
2. In Render: **New > Web Service**, connect the repo.
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Region: Frankfurt
3. Add these environment variables:

| Variable | What to put |
|---|---|
| `R2_ACCOUNT_ID` | From the R2 overview page |
| `R2_ACCESS_KEY_ID` | From the API token |
| `R2_SECRET_ACCESS_KEY` | From the API token |
| `R2_BUCKET` | `wedding-photos` |
| `EVENT_CODE` | Any short random word, e.g. `vines27`. It goes in the QR link so strangers can't find the page |
| `ADMIN_PASSWORD` | A proper password. This lets you delete photos |
| `COUPLE_NAMES` | e.g. `Paul & Alex` |
| `WEDDING_PLACE` | `Cape Winelands` |
| `WEDDING_DATE` | e.g. `January 2027` or the exact date |
| `PUBLIC_URL` | Your final URL, e.g. `https://your-app.onrender.com`. Used to build the QR code |

4. Deploy. Then go back and put the real URL into the R2 CORS policy.

**Plan:** free is fine while you test. Switch to **Starter** at least a week before the wedding and keep it for a month or two after, while people are still uploading. Free apps fall asleep and take up to a minute to wake, and guests will give up.

## 3. Get your QR code

Go to `https://your-app.onrender.com/?admin` and sign in with `ADMIN_PASSWORD`. You'll see the photo count, storage used, the guest link and a high-res QR code to download for table cards.

Test it properly before printing anything: scan the QR on an iPhone and an Android, upload a few photos each on mobile data, and check they show up.

Changing `EVENT_CODE` changes the QR code, so pick it once and leave it.

## 4. Deleting photos

Sign in at `/?admin`, open any photo, and hit Delete. Only works while signed in as admin.

## 5. Downloading everything afterwards

Use rclone. It's the easiest way to pull thousands of files.

```
rclone config
```

Choose `s3`, provider `Cloudflare`, paste your access key and secret, and set the endpoint to `https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com`. Call the remote `r2`. Then:

```
rclone copy r2:wedding-photos/photos ./wedding-photos --progress
```

The `thumbs/` folder is just small previews for the gallery. You don't need it.

## Costs

Roughly 3,000 photos from 100 guests is about 12GB. R2 charges around $0.015 per GB per month above the free 10GB, so pennies. Viewing and downloading is free. Render Starter is about $7 a month while it's on.

## Good to know

- Photos are listed newest first.
- Max 30MB per photo. That covers anything off a phone.
- iPhones normally hand the browser a JPEG, so HEIC is rarely an issue. If one does slip through, it's stored fine and shows in the gallery on Apple devices.
- Each guest's phone uploads 3 photos at a time and retries failures automatically. Anything that still fails gets a "Try again" button.
- All the settings live in the environment variables, so you never need to touch the code to change names or dates.
