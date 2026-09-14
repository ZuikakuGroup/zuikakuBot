CREATE TABLE IF NOT EXISTS volunteer_profiles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
