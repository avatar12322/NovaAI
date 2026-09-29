-- 0022: przeglądy dnia wysyłane automatycznie (rano: dziś, wieczorem: jutro) i miejsce prognozy pogody domu.
-- Ustawienia per osoba (brak wiersza = domyślnie włączone, 7:00 i 22:00, czas polski).
CREATE TABLE digest_settings (
  user_id     uuid PRIMARY KEY REFERENCES users(id),
  morning     boolean NOT NULL DEFAULT true,
  morning_at  time NOT NULL DEFAULT '07:00',
  evening     boolean NOT NULL DEFAULT true,
  evening_at  time NOT NULL DEFAULT '22:00',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE digest_settings ENABLE ROW LEVEL SECURITY;

-- Wysłane przeglądy: jeden rodzaj na osobę i dzień (także po restarcie serwera).
CREATE TABLE digest_runs (
  user_id uuid NOT NULL REFERENCES users(id),
  kind    text NOT NULL CHECK (kind IN ('morning', 'evening')),
  day     date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, day)
);
ALTER TABLE digest_runs ENABLE ROW LEVEL SECURITY;

-- Miejsce prognozy pogody (ustawia właściciel domu; tylko współrzędne i nazwa miasta).
CREATE TABLE household_weather (
  household_id uuid PRIMARY KEY REFERENCES households(id),
  place        text NOT NULL CHECK (length(place) <= 120),
  latitude     double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude    double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE household_weather ENABLE ROW LEVEL SECURITY;
