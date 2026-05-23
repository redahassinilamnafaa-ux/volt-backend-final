import { neon } from '@neondatabase/serverless';
import { sendWelcomeEmail } from './send-email.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  const { token } = req.query;
  if (!token) return res.status(400).send('Token manquant.');

  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT vt.*, u.email, u.first_name
    FROM verify_tokens vt
    JOIN users u ON u.id = vt.user_id
    WHERE vt.token = ${token}
    AND vt.expires_at > NOW()
  `;

  if (!rows.length) {
    return res.redirect('https://energy-volt.vercel.app?verify=expired');
  }

  const { user_id, email, first_name } = rows[0];
  await sql`UPDATE users SET email_verified = true WHERE id = ${user_id}`;
  await sql`DELETE FROM verify_tokens WHERE token = ${token}`;

  try { await sendWelcomeEmail(email, first_name); } catch(e) {}

  return res.redirect('https://energy-volt.vercel.app?verify=success');
}
