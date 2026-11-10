# bazaar-contrib-messages

The message contracts are installed with the Node implementation.

```sh
bcn contrib add messages --enable messages-node
```

The corresponding entry in `config.toml`:

```toml
version = "5"

[[contribs]]
package = "bazaar-contrib-messages==0.3.*"
[[contribs.enabled]]
entry = "messages-node"
```

Use `bcc message check`, `bcc message read`, and `bcc message send` from an agent session.
