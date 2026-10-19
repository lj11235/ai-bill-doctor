-- All money is integer nano-USD (1 dollar = 1,000,000,000 units).
-- One locked control row serializes admission, dispatch and settlement across workers.
CREATE TABLE beta_control (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  killed boolean NOT NULL DEFAULT true,
  mode text NOT NULL DEFAULT 'unconfigured' CHECK (mode IN ('unconfigured','demo','live')),
  pricing_hash text,
  identity_hash text,
  accounted_units bigint NOT NULL DEFAULT 0 CHECK (accounted_units >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO beta_control(id) VALUES (true);
CREATE TABLE beta_days (
  day date PRIMARY KEY,
  accounted_units bigint NOT NULL DEFAULT 0 CHECK (accounted_units >= 0)
);
CREATE TABLE beta_runs (
  id uuid PRIMARY KEY,
  owner uuid NOT NULL,
  visitor_hash text NOT NULL,
  ip_hash text NOT NULL,
  body_hash text NOT NULL,
  day date NOT NULL REFERENCES beta_days(day),
  reserved_units bigint NOT NULL CHECK (reserved_units BETWEEN 1 AND 250000000),
  accounted_units bigint NOT NULL CHECK (accounted_units >= 0),
  state text NOT NULL CHECK (state IN ('reserved','running','settled','uncertain')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX beta_visitor_day ON beta_runs(visitor_hash,day);
CREATE INDEX beta_ip_day ON beta_runs(ip_hash,day);
CREATE INDEX beta_active ON beta_runs(state) WHERE state <> 'settled';
CREATE TABLE beta_calls (
  run_id uuid NOT NULL REFERENCES beta_runs(id),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 2),
  model text NOT NULL CHECK (model IN ('gpt-6-astra','gpt-6.1-sol','gpt-6-luna')),
  bound_units bigint NOT NULL CHECK (bound_units > 0),
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','dispatched','known')),
  cost_units bigint CHECK (cost_units >= 0),
  outcome text CHECK (outcome IN ('complete','incomplete')),
  PRIMARY KEY(run_id,ordinal),
  CHECK ((state='known') = (cost_units IS NOT NULL))
);
-- Keyed network hash + minute bucket. Events use a separate daily visitor hash.
-- No raw IP addresses, prompts, outputs, headers or keys.
CREATE TABLE beta_throttle (
  ip_hash text NOT NULL,
  bucket bigint NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY(ip_hash,bucket)
);
CREATE TABLE beta_events (
  id uuid PRIMARY KEY,
  day date NOT NULL,
  visitor_day_hash text NOT NULL,
  name text NOT NULL CHECK (name IN ('landing_visit','benchmark_start','benchmark_completion','candidate_accepted','candidate_rejected','recommendation_copied','pricing_interest')),
  run_id uuid REFERENCES beta_runs(id),
  candidate_index smallint CHECK (candidate_index BETWEEN 0 AND 1),
  UNIQUE NULLS NOT DISTINCT(day,visitor_day_hash,name,run_id,candidate_index)
);
CREATE INDEX beta_event_day ON beta_events(day,name);
CREATE TABLE beta_operator_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  action text NOT NULL CHECK (action IN ('initialize','kill','resume','close_uncertain')),
  run_id uuid REFERENCES beta_runs(id)
);
