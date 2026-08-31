schema.sql

DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS registrations;
DROP TABLE IF EXISTS user_states;
DROP TABLE IF EXISTS settings;

CREATE TABLE users (
                       telegram_id INTEGER PRIMARY KEY,
                       username TEXT,
                       role TEXT NOT NULL DEFAULT 'student',
                       full_name TEXT,
                       phone TEXT,
                       identifier TEXT,
                       user_type TEXT
);

CREATE TABLE events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        title TEXT NOT NULL,
                        description TEXT,
                        poster_file_id TEXT,
                        event_type TEXT NOT NULL,
                        price INTEGER DEFAULT 0,
                        format_type TEXT NOT NULL,
                        location_or_link TEXT,
                        event_date TEXT,
                        capacity INTEGER NOT NULL,
                        status TEXT NOT NULL DEFAULT 'active',
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE registrations (
                               id INTEGER PRIMARY KEY AUTOINCREMENT,
                               event_id INTEGER NOT NULL,
                               telegram_id INTEGER NOT NULL,
                               status TEXT NOT NULL,
                               receipt_file_id TEXT,
                               registration_date DATETIME DEFAULT CURRENT_TIMESTAMP,
                               UNIQUE(event_id, telegram_id)
);

CREATE TABLE user_states (
                             user_id INTEGER PRIMARY KEY,
                             state TEXT
);

CREATE TABLE settings (
                          key TEXT PRIMARY KEY,
                          value TEXT
);