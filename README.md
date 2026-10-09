# odcinkowy-pomiar-predkosci

This repository is the data source for [przyhamuj.pl](https://przyhamuj.pl/).

The `canard.json` file is refreshed every morning from the
[CANARD device map](https://www.canard.gitd.gov.pl/cms/o-nas/mapa-urzadzen).
Run `node scripts/fetch-canard.mjs` to update it locally. The updater waits one
second after each detail request. Failed item downloads are retried twice with
exponential backoff. Unavailable control-point details are stored as `null`. For
other categories, the updater keeps the last known detail from `canard.json`.
CANARD's uncompressed empty control-point placeholders, `[{}]` and `[]`, are
treated as an empty dataset and skipped with a warning.
Set another retry count with `--item-retries`, for example
`node scripts/fetch-canard.mjs --item-retries 5`.

Run `node --test scripts/fetch-canard.test.mjs` to check the updater.

The map index is parsed within the request retry loop: HTTP failures and pages
with missing or invalid map configuration are retried up to four total attempts.
Retry warnings include the parsing error; a missing namespace also reports the
page title and response length. If all attempts fail, the updater exits without
overwriting `canard.json`.
