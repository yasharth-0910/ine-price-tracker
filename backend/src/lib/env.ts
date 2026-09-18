// Validated at boot. Missing required vars exit the process naming each one,
// so a misconfigured deploy fails loudly instead of half-starting.

const required = ['DATABASE_URL'] as const;

const missing = required.filter((k) => !process.env[k]?.trim());
if (missing.length > 0) {
  console.error(
    `Missing required environment variable(s): ${missing.join(', ')}.\n` +
      `See backend/.env.example.`,
  );
  process.exit(1);
}

export const env = {
  DATABASE_URL: process.env.DATABASE_URL as string,
  PORT: Number(process.env.PORT) || 4000,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  NODE_ENV: process.env.NODE_ENV || 'development',
};
