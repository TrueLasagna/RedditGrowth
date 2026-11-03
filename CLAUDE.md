# RedditGrowth portal: notes for Claude

- **Push changes straight to `main`.** The owner asked for no pull requests or merging. Vercel deploys `main` to production automatically (project `reddit-growth`, team `essay-bank`, https://reddit-growth-three.vercel.app).
- Run `npm test` before pushing.
- Hosting: Vercel. Database: Neon Postgres via `DATABASE_URL` (set in Vercel). Without `DATABASE_URL`, local runs and tests use PGlite.
- Admin sign-in is at `/admin`; clients sign in at `/login`.
- Brand: near-black background, red accent `#FF2A1A`, Outfit font, matching redditgrowth.com. Colour tokens are at the top of `public/static/css/styles.css`.
