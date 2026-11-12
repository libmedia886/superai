# bazaar-contrib-manager

Install and manage contrib packages with `bcn contrib`.

```sh
bcn contrib add manager --enable
bcn contrib list
bcn contrib configured
bcn contrib --help
```

The corresponding entry in `config.toml`:

```toml
version = "5"

[[contribs]]
package = "bazaar-contrib-manager==0.3.*"
[[contribs.enabled]]
entry = "contrib-manager"
[[contribs.enabled]]
entry = "contrib-indexes"
```

## Index entries

Each local file, HTTP(S) index or `resource://` index uses the same document:

```json
{
  "contribs": [
    {
      "package": "bazaar-contrib-telegram",
      "source": "https://pypi.org/simple/",
      "summary": "Connect agents to Telegram",
      "description": "A Telegram channel for Bazaar Compute Node agents.",
      "icon_url": "https://example.org/icons/telegram.svg"
    }
  ]
}
```

`package` and `source` are required. `summary` (short text), `description`
(Markdown) and `icon_url` (image URL) are optional display fields maintained by
the index author. Omitted fields are `None` and their corresponding UI regions
are omitted.

Entries with the same package and source share one catalog entry. The last entry
in configured index order supplies its display fields, including omissions;
the catalog retains all index locations. Different sources remain separate
choices. Display fields are preserved in the index cache and catalog results.

Use `bcn contrib index add <location>` to append an index and
`bcn contrib index refresh` to refresh online indexes.
