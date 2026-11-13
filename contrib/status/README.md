# bazaar-contrib-status

Read contrib instance status through `ctx.accept(CONTRIB_STATUS).snapshot()`.

`states()` returns serializable records with the instance ID, entry name,
configuration location, lifecycle state, error and parent. The `contrib-status`
remote entry exposes this query to other processes, so a server can display a
computer's actual contrib states through the ordinary sidecar protocol.

```sh
bcn contrib add status --enable
```

The corresponding entry in `config.toml`:

```toml
version = "5"

[[contribs]]
package = "bazaar-contrib-status==0.3.*"
[[contribs.enabled]]
entry = "status"
```
