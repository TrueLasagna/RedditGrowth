# RedditGrowth Client Portal

A web app with two sides:

- **Admin portal** (`/admin`): for you. Create client logins, set each client's view plan and price, upload logos, add live posts and update their views, and upload draft posts for clients to approve.
- **Client portal** (`/`): for your customers. Branded with their logo, it shows their plan, total views and live posts, and lets them approve or deny drafts.

Clients can't sign up. Only the admin creates their accounts.

## Put it online (Vercel + Neon)

The portal runs on **Vercel** with a **Neon** Postgres database, the same setup as Essay Bank.

1. **Create the database.** In [Neon](https://console.neon.tech), create a new project (for example `redditgrowth`). On the project dashboard click **Connect** and copy the connection string. It starts with `postgresql://`.
2. **Import the repo into Vercel.** In [Vercel](https://vercel.com/new), choose **Import** next to `TrueLasagna/RedditGrowth`. Leave the build settings as they are; `vercel.json` already sets them.
3. **Add environment variables** (in the import screen, or later under Settings → Environment Variables):

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | the Neon connection string |
   | `ADMIN_USERNAME` | the admin username you want |
   | `ADMIN_PASSWORD` | a strong admin password |

4. Click **Deploy**. When it finishes, open `https://<your-project>.vercel.app/admin` and sign in. The tables and your admin account are created on the first visit.
5. Optional: add your own domain (for example `portal.redditgrowth.com`) under the Vercel project's Settings → Domains.

`ADMIN_USERNAME` and `ADMIN_PASSWORD` are only used the first time, to create the admin. After that, change your password under Admin → Settings.

## Run it on your computer

Needs Node.js 20 or newer.

```bash
npm install
npm run seed
npm start
```

Open http://localhost:3000/admin. Without `DATABASE_URL`, it uses a built-in local database in `data/` (good for trying things out; your real data lives in Neon). The admin login is printed in the terminal the first time. `npm run seed` adds two demo clients (logins `acme` and `northwind`, password `demo-pass-123`).

To work against your Neon database instead, set `DATABASE_URL` first. Forgot the admin password? With `DATABASE_URL` set to your Neon string, run `npm run reset-admin -- yourname 'new-password'`.

## Where things are

| What | Where |
| --- | --- |
| Admin sign in | `/admin/login` |
| Client sign in | `/login` |
| Brand colours | top of `public/static/css/styles.css` (`--brand` and friends) |
| Your logo | put `logo.png` (or `.svg`) in `public/static/img/` and redeploy. It replaces the built-in placeholder everywhere. |
| Database (clients, posts, drafts, logos) | Neon (`DATABASE_URL`) |

## How client data is kept separate

- One Postgres database (Neon). Every post and draft belongs to a client, and every query for client data is filtered by that client.
- On the client side, the client comes from their login session, never from the URL. A client can't view or change another client's posts, drafts or logo by editing a link.
- Each client's logo is stored in the database against that client and is only served to that client or the admin.
- Deleting a client removes their posts, drafts and logo. Deactivating a client signs them out and blocks their login but keeps their data.

## Security

- Passwords are hashed with bcrypt (cost 12). Plain-text passwords are never stored.
- Sessions are random tokens in HTTP-only, SameSite, Secure cookies. Only a hash of each token is stored.
- Every form is protected against CSRF.
- Logo uploads are checked by file content: PNG, JPG, WebP or GIF only, 2 MB max.
- Strict security headers via Helmet.

## Tests

```bash
npm test
```

Runs on the built-in local database. Set `TEST_DATABASE_URL` to an empty Postgres database to run the same tests against real Postgres.

Covers login, password hashing, CSRF protection, creating clients, posts and drafts, approving and denying drafts, keeping client data separate, and deactivation.
