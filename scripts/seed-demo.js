// Adds two demo clients with posts and drafts so you can try the portal.
// Usage: npm run seed      (demo client logins: acme / demo-pass-123 and northwind / demo-pass-123)
const { db } = require('../src/db');
const { hashPassword } = require('../src/auth');

const demo = [
  { company: 'Acme Analytics', user: 'acme', plan: 500000, price: 250000,
    posts: [
      ['SaaS', 'We cut our churn by 38% with one onboarding email — here is the exact copy', 184200],
      ['startups', 'What I learned building a data tool for non-technical founders', 96500],
      ['analytics', 'Free dashboard template for tracking product-led growth', 41300],
    ],
    drafts: [
      ['Entrepreneur', 'The 5 metrics I check every Monday morning (and why)', 'pending'],
      ['marketing', 'Our attribution model was wrong for two years. Here is how we found out.', 'pending'],
      ['SaaS', 'AMA: we grew from 0 to 2,000 customers without paid ads', 'approved'],
      ['smallbusiness', 'Stop using vanity metrics', 'denied'],
    ] },
  { company: 'Northwind Coffee', user: 'northwind', plan: 250000, price: 120000,
    posts: [['Coffee', 'I visited 40 roasters in 30 days. These 6 changed how I brew at home.', 72100]],
    drafts: [['espresso', 'Dialing in a light roast: our head roaster\'s cheat sheet', 'pending']] },
];

const body = 'Hey everyone,\n\nThis is a sample post body. Your real drafts will show the full text here so clients can read every word before approving.\n\nThanks for reading!';

db.transaction(() => {
  for (const d of demo) {
    if (db.prepare('SELECT 1 FROM clients WHERE username = ?').get(d.user)) { console.log(`Skipping ${d.user} (exists)`); continue; }
    const id = db.prepare(`INSERT INTO clients (company_name, contact_name, contact_email, username, password_hash, plan_views, price_cents)
      VALUES (?,?,?,?,?,?,?)`).run(d.company, 'Demo Contact', `hello@${d.user}.example`, d.user, hashPassword('demo-pass-123'), d.plan, d.price).lastInsertRowid;
    for (const [sub, title, views] of d.posts) {
      db.prepare('INSERT INTO posts (client_id, subreddit, title, body, views) VALUES (?,?,?,?,?)').run(id, sub, title, body, views);
    }
    for (const [sub, title, status] of d.drafts) {
      db.prepare(`INSERT INTO drafts (client_id, subreddit, title, body, status, decided_at, client_note) VALUES (?,?,?,?,?,?,?)`)
        .run(id, sub, title, body, status, status === 'pending' ? null : new Date().toISOString().slice(0, 19).replace('T', ' '),
          status === 'denied' ? 'Too negative for our brand voice — can we make it more positive?' : '');
    }
    console.log(`Created ${d.company} → username: ${d.user}  password: demo-pass-123`);
  }
})();
