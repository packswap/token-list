# PackSwap token list

The tokens and logos listed on [PackSwap](https://packswap.xyz), the DEX aggregator on DogeOS.

Any token can be traded on PackSwap without being here: people import it in the app, with a warning. Being listed means it shows in the token list with its name and logo, without the warning.

## Request a listing

Open a pull request that adds one folder for your token. Only DogeOS testnet is open for now.

```
tokens/dogeos-testnet/<token address in lower case>/
  info.json
  logo.svg    (or logo.png)
```

`info.json`:

```json
{
  "address": "0xD19d2Ffb1c284668b7AFe72cddae1BAF3Bc03925",
  "name": "USD Coin",
  "symbol": "USDC",
  "decimals": 18,
  "website": "https://example.com",
  "x": "https://x.com/example",
  "proof": "https://x.com/example/status/123",
  "logoSource": "Our own logo, and PackSwap may use it"
}
```

| Field | Rule |
|---|---|
| `address` | Checksummed. A contract on DogeOS |
| `name`, `symbol`, `decimals` | Exactly what the token's contract reports. Plain English letters, digits and basic punctuation |
| `website`, `x` | The project's own, as `https` links |
| `proof` | An `https` link to a post on the project's X, or a page on its website, that shows this token's address. It is how we know the request comes from the project |
| `logoSource` | Whose logo it is, and that PackSwap may use it |
| `tags` | Optional: `stablecoin` or `wrapped` |

The logo:

- SVG or PNG, square, at most 100 KB. A PNG is at least 256×256.
- An SVG is a plain drawing: no scripts, styles, links, embedded images or anything from outside the file.

## What happens next

1. **Automatic checks** run on your pull request. They read the token from the chain and check the logo and the rules above. Their result is on the pull request, in the check's summary.
2. **We review it by hand**, including your proof.
3. **Once merged**, the token goes live with the next PackSwap release. Listing is not instant, and it is not a guarantee of anything about a token.

A request is refused if its symbol reads like one already listed (`WD0GE` and `WDOGE` count as the same), or if its name or logo is already used. One request is one token, and changes nothing outside its folder.

To run the checks yourself, with Node 22 and nothing to install:

```sh
node --test scripts/check.test.mjs
node scripts/check.mjs --base origin/main
```

## Logos

Each logo belongs to its project. `logoSource` in each token's `info.json` says where it came from.

To report a token or logo that should not be here, open an issue.
