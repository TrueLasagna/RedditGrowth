# RedditGrowth Client Portal

A web app with two sides:

- **Admin portal** (`/admin`): for you. Create client logins, set each client's view plan and price, upload logos, add live posts and update their views, and upload draft posts for clients to approve.
- **Client portal** (`/`): for your customers. Branded with their logo, it shows their plan, total views and live posts, and lets them approve or deny drafts.

Clients can't sign up. Only the admin creates their accounts.

## Run it locally

Needs Node.js 20 or newer.

```bash
npm install
ADMIN_USERNAME=yourname ADMIN_PASSWORD='choose-a-strong-password' npm start
```

Open http://localhost:3000/admin and sign in. The admin account is created the first time the app starts. If you don't set `ADMIN_PASSWORD`, a random one is printed in the terminal once.

Want sample data to click around? Run `npm run seed`. It creates two demo clients (logins `acme` and `northwind`, password `demo-pass-123`).

Forgot the admin password? Run `npm run reset-admin -- yourname 'new-password'`.

## Where things are

| What | Where |
| --- | --- |
| Admin sign in | `/admin/login` |
| Client sign in | `/login` |
| Brand colours | top of `public/css/styles.css` (`--brand` and friends) |
| Your logo | put `logo.png` (or `.svg`) in `public/img/` and restart. It replaces the built-in placeholder everywhere. |
| Database and uploaded logos | `data/` (created automatically; back this folder up) |

## How client data is kept separate

- One SQLite database. Every post and draft belongs to a client, and every query for client data is filtered by that client.
- On the client side, the client comes from their login session, never from the URL. A client can't view or change another client's posts, drafts or logo by editing a link.
- Each client's logo lives in its own folder (`data/uploads/client-<id>/`) and is only served to that client or the admin.
- Deleting a client removes their posts, drafts and logo. Deactivating a client signs them out and blocks their login but keeps their data.

## Security

- Passwords are hashed with bcrypt (cost 12). Plain-text passwords are never stored.
- Sessions are random tokens in HTTP-only, SameSite cookies (also `Secure` when `NODE_ENV=production`). Only a hash of each token is stored.
- Every form is protected against CSRF, and failed logins are rate-limited.
- Logo uploads are checked by file content: PNG, JPG, WebP or GIF only, 2 MB max.
- Strict security headers via Helmet.

## Deploying

Any host that runs Node.js and has a **persistent disk** works (Render, Railway, Fly.io, a VPS):

- Build command: `npm install`
- Start command: `npm start`
- Environment: `NODE_ENV=production`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `DATA_DIR` set to a folder on the persistent disk (for example `/var/data`).
- Serve it over HTTPS (those hosts do this for you).

## Tests

```bash
npm test
```

Covers login, password hashing, CSRF protection, creating clients, posts and drafts, approving and denying drafts, keeping client data separate, and deactivation.
