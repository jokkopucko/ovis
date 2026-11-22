# Telemetry receiver

The Cloudflare Worker that receives the app's anonymous install and update counts and its daily
active message. What the app
sends and when is in [the guide](../docs/guide.md#anonymous-usage-counts); the sender is
`server/telemetry.ts`.

It stores one row per install, event and version in a D1 table (`schema.sql`): the day, the
event, the random install ID, the version and the version it replaced, the OS, the CPU
architecture, how the app was installed, the terminal runtime its server serves (`runtime`:
`herdr` or `herdr-core`, `NULL` from apps before it), and `settings`, a JSON snapshot validated by the shared
schema in `shared/telemetry.ts` (`NULL` when the sender has not provided one). The snapshot
contains only allowlisted enums, booleans and bounded numbers, never raw user-entered strings or
account identifiers. It adds the country the request came from: the two characters Cloudflare
works out from the sender's address (`request.cf.country`, such as `KR`), and nothing finer (no
city, region or network; a request Cloudflare marks as Tor or unknown is stored with no country).
A second table, `active`, holds one row per install and UTC day the app was opened in a browser
(`POST /v1/active`): the day, the random install ID, the version, the OS, the CPU architecture, how
the app was installed, the terminal runtime, the country, and `harnesses`, a JSON array of the kinds of coding agents
running that day, from the fixed list `TELEMETRY_HARNESSES` in `shared/telemetry.ts` (any other
agent is `other`). A later message for the same day replaces the version and the harnesses.
A third table, `counts`, holds one row per install and UTC day that has ended, for apps since notice
version 6, which says so (`POST /v1/counts`): the day, the random install ID, the app's version that day, and
`narrow` and `wide`, the day's use of the app's controls in a window at most 640px wide and in a
wider one: for each fixed counter name used that day (`TELEMETRY_COUNTERS` in `shared/telemetry.ts`,
such as `chat_send` or `view_terminal_claude`), a bucket (1: 1-2 times, 2: 3-9, 3: 10-29, 4: 30 or
more), and the fixed names of the controls shown that day (`TELEMETRY_SHOWN`). It carries no country,
OS or agent kinds: join `active` on the day and install. The first message for a day stands, and a
name the Worker does not know is dropped while the rest of the row is kept. No row for a day the
install was active means its counts are unknown (an older app, the notice not seen, or not sent yet:
the Worker takes a day up to `COUNTS_LATE_DAYS`, 14, back).
A day's row is what the PC had when it sent the day: five minutes (`COUNTS_SETTLE_MS`) after the day's
UTC midnight, or at the first start or visit after that, longer than a page holds its counts (a minute).
A batch held past that, by a tab frozen across midnight, is kept on the PC but not sent while the same
server runs; after a restart it goes in a second message for the day, which the Worker ignores, or it is
dropped once the day is too old to send.
The Worker itself never reads the sender's address or any header other than the content type, and
Workers Logs are off (`wrangler.toml`), so no request log keeps the address either.

## Deploy

Prepare the database before deploying the Worker, then release the app version that sends
snapshots only after the Worker is deployed. On a brand-new database, create it and apply the
schema:

```sh
cd telemetry
bunx wrangler login
bunx wrangler d1 create herdr-web-ui-telemetry   # done once: its database_id is in wrangler.toml; only a new account repeats it
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --file schema.sql
```

For an existing database, `schema.sql` does not add columns to its existing table. Add whichever
columns are missing, in this order, before deploying the Worker. A database that predates country
collection needs `country`:

```sh
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --command "ALTER TABLE events ADD COLUMN country TEXT"
```

Then add `settings` to any existing database that does not have it:

```sh
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --command "ALTER TABLE events ADD COLUMN settings TEXT"
```

Create the `active` table on an existing database too:

```sh
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --command "CREATE TABLE IF NOT EXISTS active (day TEXT NOT NULL, install_id TEXT NOT NULL, version TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL, install_method TEXT NOT NULL CHECK (install_method IN ('plugin','managed','source')), country TEXT, harnesses TEXT NOT NULL CHECK (json_valid(harnesses)), PRIMARY KEY (day, install_id)); CREATE INDEX IF NOT EXISTS active_day ON active (day);"
```

Then add `usage` to an `active` table that does not have it, before deploying a Worker that writes
it (an app since notice version 5 sends the day's usage; that Worker's insert fails on a table
without the column):

```sh
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --command "ALTER TABLE active ADD COLUMN usage TEXT CHECK (usage IS NULL OR json_valid(usage))"
```

Then add `runtime` to both tables, before deploying a Worker that writes it (an app since it was
added names the terminal runtime its server serves, `herdr` or `herdr-core`; rows from older apps
keep `NULL`):

```sh
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --command "ALTER TABLE events ADD COLUMN runtime TEXT CHECK (runtime IS NULL OR runtime IN ('herdr', 'herdr-core'))"
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --command "ALTER TABLE active ADD COLUMN runtime TEXT CHECK (runtime IS NULL OR runtime IN ('herdr', 'herdr-core'))"
```

Then create the `counts` table, before deploying a Worker that writes it (an app since notice
version 6 sends a finished day's counts; that Worker's insert fails without the table):

```sh
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --command "CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, install_id TEXT NOT NULL, version TEXT NOT NULL, narrow TEXT CHECK (narrow IS NULL OR json_valid(narrow)), wide TEXT CHECK (wide IS NULL OR json_valid(wide)), PRIMARY KEY (day, install_id)); CREATE INDEX IF NOT EXISTS counts_day ON counts (day);"
```

These ALTERs preserve historical rows; their newly added `settings` value remains `NULL` and is
not inferred from old data.

A Worker change goes to staging first: the `staging` environment in `wrangler.toml` is the same
Worker with a database of its own, `herdr-web-ui-telemetry-staging`, at
`https://herdr-web-ui-telemetry-staging.<account>.workers.dev`, which no app sends to. Post the new
message there and read it back before deploying to production. On a new account, create that
database once, put its `database_id` in `[[env.staging.d1_databases]]` in `wrangler.toml`, and apply
the schema; then deploy:

```sh
bunx wrangler d1 create herdr-web-ui-telemetry-staging   # a new account only
bunx wrangler d1 execute herdr-web-ui-telemetry-staging --env staging --remote --file schema.sql   # a new staging database only
bunx wrangler deploy --env staging
```

After the database is ready and staging took the change, deploy the Worker and then release the
app version that sends snapshots:

```sh
bunx wrangler deploy
```

Then record the deploy with `bun scripts/release-guards.ts --worker-deployed` and commit
`telemetry/deployed.json`: a release whose Worker sources differ from the recorded ones fails. Any
edit to `telemetry/worker.ts` or `shared/telemetry.ts` counts, comments included, so a redeploy that
changes nothing is sometimes the price.

The Worker answers at `https://herdr-web-ui-telemetry.<account>.workers.dev/v1/events`, and
`TELEMETRY_URL` in `server/telemetry.ts` must name that address. `OVIS_TELEMETRY_URL` does not
exist on purpose: an install cannot be pointed elsewhere by its environment.

The Worker and its D1 database keep the `herdr-web-ui-telemetry` name they had before Ovis took its
name: installs already send to that address, and a D1 database cannot be renamed.

## Reading the counts

After `bunx wrangler login` from `telemetry/`, run
`bun scripts/telemetry-report.ts --out ~/telemetry-report.md` from the repository root (write it outside the tree:
it holds counts no one has published; `telemetry-report*.md` and `*.html` at the root are ignored by git for a
slip). It runs the weekly installs, DAU, WAU, MAU, agent-kind and country queries below, plus daily actives per
country for the last 28 days and the last 7 finished days' button counts, and writes them as one report;
`--html <file.html>` also writes them as one page with the shares drawn as bars. For the button counts, per width:

- the share of installs that used each counter, with `of`, the installs it is a share of, counted in the same
  statement: under about ten installs a share is noise, and over one install it reads 100%;
- the middle install's day on the days it used the counter: each install first gets one value, the lower middle of
  its ranges on those days (a recorded day it did not use it is not one of them), then the middle install is taken, so a few heavy installs do not carry it; only ranges are sent and none is
  averaged, so when the two middle installs differ both ranges are named (`1-2 .. 30+`);
- the controls shown, and chat/terminal switches by kind of agent: an install runs an agent there when that day's
  active message or its own switch counts name it, and switched when its counts hold a switch on that agent's panes;
  `shell` (a pane with no agent) shows switches alone (`-` for running), since no visit names it.

The queries of one run share one cut-off day, worked out once, so a run across UTC midnight still agrees with itself. The script selects `telemetry/` as Wrangler's working directory.
For the individual queries below, stay in `telemetry/`:

```sh
bunx wrangler d1 execute herdr-web-ui-telemetry --remote --command "<query>"
```

```sql
-- new installs per week
SELECT strftime('%Y-%W', day) AS week, COUNT(*) FROM events WHERE event = 'install' GROUP BY week ORDER BY week;
-- daily active installs (DAU)
SELECT day, COUNT(*) FROM active GROUP BY day ORDER BY day;
-- weekly active installs (WAU), the last 7 days including today
SELECT COUNT(DISTINCT install_id) FROM active WHERE day >= date('now', '-6 days');
-- monthly active installs (MAU), the last 30 days including today
SELECT COUNT(DISTINCT install_id) FROM active WHERE day >= date('now', '-29 days');
-- active installs per calendar month
SELECT strftime('%Y-%m', day) AS month, COUNT(DISTINCT install_id) FROM active GROUP BY month ORDER BY month;
-- installs running each kind of agent in the last 30 days
SELECT harness.value AS harness, COUNT(DISTINCT active.install_id) AS installs
FROM active CROSS JOIN json_each(active.harnesses) AS harness
WHERE active.day >= date('now', '-29 days')
GROUP BY harness.value ORDER BY installs DESC, harness;
-- installs whose app was opened on each kind of screen in the last 30 days (rows with usage only)
SELECT surface.value AS surface, COUNT(DISTINCT active.install_id) AS installs
FROM active CROSS JOIN json_each(active.usage, '$.surfaces') AS surface
WHERE active.day >= date('now', '-29 days') AND active.usage IS NOT NULL
GROUP BY surface.value ORDER BY installs DESC, surface;
-- installs reached each way in the last 30 days (rows with usage only)
SELECT way.value AS ingress, COUNT(DISTINCT active.install_id) AS installs
FROM active CROSS JOIN json_each(active.usage, '$.ingress') AS way
WHERE active.day >= date('now', '-29 days') AND active.usage IS NOT NULL
GROUP BY way.value ORDER BY installs DESC, ingress;
-- prompt answers sent and pane alerts delivered and tapped per day, with the installs that reported usage
SELECT day, COUNT(*) AS installs, SUM(json_extract(usage, '$.prompt_answers')) AS prompt_answers,
  SUM(json_extract(usage, '$.alerts_delivered')) AS alerts_delivered, SUM(json_extract(usage, '$.alerts_opened')) AS alerts_opened
FROM active WHERE usage IS NOT NULL GROUP BY day ORDER BY day;
-- share of installs that used each counter at least once in the last 7 finished days, per width, among
-- installs that sent counts at that width; a bucket's lower bound is 1, 3, 10 or 30 uses that day
SELECT width, item.key AS counter, COUNT(DISTINCT c.install_id) AS installs,
  ROUND(100.0 * COUNT(DISTINCT c.install_id) / (SELECT COUNT(DISTINCT install_id) FROM counts WHERE day >= date('now', '-7 days') AND day < date('now') AND (CASE width WHEN 'narrow' THEN narrow ELSE wide END) IS NOT NULL), 1) AS percent
FROM (SELECT 'narrow' AS width UNION ALL SELECT 'wide') AS w
JOIN counts c ON (CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END) IS NOT NULL
CROSS JOIN json_each(CASE w.width WHEN 'narrow' THEN c.narrow ELSE c.wide END, '$.counts') AS item
WHERE c.day >= date('now', '-7 days') AND c.day < date('now')
GROUP BY width, counter ORDER BY width, installs DESC, counter;
-- installs per version they last reported
SELECT version, COUNT(*) FROM (SELECT install_id, MAX(version) AS version FROM events GROUP BY install_id) GROUP BY version ORDER BY version;
-- OS, architecture and install method
SELECT os, arch, install_method, COUNT(DISTINCT install_id) FROM events GROUP BY os, arch, install_method;
-- active installs per terminal runtime and install method, the last 7 days (NULL: apps from before runtime)
SELECT runtime, install_method, COUNT(DISTINCT install_id) FROM active WHERE day >= date('now', '-6 days') GROUP BY runtime, install_method;
-- installs per country, each counted once under the last country it was seen in; NULL is an
-- install never seen with one (heard from only before the country was kept, or never named one)
SELECT country, COUNT(*) FROM (
  SELECT (SELECT country FROM events WHERE install_id = e.install_id AND country IS NOT NULL ORDER BY rowid DESC LIMIT 1) AS country
  FROM events e GROUP BY install_id
) GROUP BY country ORDER BY 2 DESC;
-- values of every setting in the last non-NULL snapshot per install; installs with no snapshot
-- are excluded, and a later event with settings=NULL does not replace a prior snapshot
WITH latest_settings AS (
  SELECT install_id, settings,
    ROW_NUMBER() OVER (PARTITION BY install_id ORDER BY rowid DESC) AS recency
  FROM events
  WHERE settings IS NOT NULL
)
SELECT setting.key, setting.type, setting.value, COUNT(*) AS installs
FROM latest_settings
CROSS JOIN json_each(latest_settings.settings) AS setting
WHERE latest_settings.recency = 1
GROUP BY setting.key, setting.type, setting.value
ORDER BY setting.key, installs DESC, setting.type, setting.value;
-- a focused distribution using json_extract: theme in each install's last non-NULL snapshot
WITH latest_settings AS (
  SELECT install_id, settings,
    ROW_NUMBER() OVER (PARTITION BY install_id ORDER BY rowid DESC) AS recency
  FROM events
  WHERE settings IS NOT NULL
)
SELECT json_extract(settings, '$.theme') AS theme, COUNT(*) AS installs
FROM latest_settings
WHERE recency = 1
GROUP BY theme
ORDER BY installs DESC, theme;
```

`MAX(version)` compares text, which orders `0.10.0` before `0.9.0`; read the version table with
that in mind once a part reaches two digits.

Anyone can post an event that passes the checks, so the counts are a trend, not an audit.
