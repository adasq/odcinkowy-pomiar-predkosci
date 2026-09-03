# odcinkowy-pomiar-predkosci

This repository is the data source for [przyhamuj.pl](https://przyhamuj.pl/).

The `canard.json` file is refreshed every morning from the
[CANARD device map](https://www.canard.gitd.gov.pl/cms/o-nas/mapa-urzadzen).
Run `node scripts/fetch-canard.mjs` to update it locally. Failed item downloads
are retried twice with exponential backoff. If CANARD lists an item but its
detail remains unavailable, the updater keeps its last known detail from
`canard.json`. Set another retry count with `--item-retries`, for example
`node scripts/fetch-canard.mjs --item-retries 5`.
