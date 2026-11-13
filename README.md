# odcinkowy-pomiar-predkosci

This repository is the data source for [przyhamuj.pl](https://przyhamuj.pl/).

The `canard.json` file is refreshed every morning from the
[CANARD device map](https://www.canard.gitd.gov.pl/mapa).
Run `node scripts/fetch-canard.mjs` to update it locally. The updater waits one
second after each detail request. Failed item downloads are retried twice with
exponential backoff. Unavailable control-point details are stored as `null`. For
other categories, the updater keeps the last known detail from `canard.json`.
Empty control-point indexes are skipped with a warning. Empty indexes for other
categories are rejected to avoid replacing the data with an incomplete download.
Set another retry count with `--item-retries`, for example
`node scripts/fetch-canard.mjs --item-retries 5`.

Run `node --test scripts/fetch-canard.test.mjs` to check the updater.

CANARD migrated from the Liferay map to a new API in November 2026; the old map
URL now redirects to the Gov.pl homepage. The updater reads the public GUI
configuration and uses the same anonymous login as the map. Client credentials
are read at runtime, never stored in the output. Expired access tokens are renewed
on HTTP 401. API responses are decoded from their transport charset (including
UTF-16 with a byte-order mark), then decompressed with LZString.

Configuration and category indexes are parsed within the request retry loop.
HTTP failures and invalid indexes are retried up to four total attempts. If the
download fails, the updater exits without overwriting `canard.json`.

### Output schema migration

New downloads have `schemaVersion: 2` and retain the `count` / `records` envelope
and category labels. `summary` and `detail` contain the new API's unmodified
objects; `detailUrl` is now the object's GET endpoint (requiring an access token).
Upstream IDs changed from numbers to opaque strings. Details are now flat:
device fields previously under `detail.urzadzenie` are directly under `detail`,
and speed limits are in `detail.limityPredkosci`, not `detail.limity`.
Some legacy fields, including accident statistics, are no longer supplied.
Consumers, including przyhamuj.pl, must support this schema before using new
downloads. Previous details are reused only for the same category and upstream
ID; legacy numeric IDs cannot be matched to the new IDs.
