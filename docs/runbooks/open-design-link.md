# Link an Open Design project

Select a Project in Factory, then choose **🎨 Link Open Design…**. Projects on the execution host are discovered from Open Design's offline catalog, even when the app is closed. Choose a project to link it.

For a remote execution host, choose **Choose Open Design folder on this computer…** and grant read access to the local Open Design data folder once. Factory reads `app.sqlite` (including committed WAL records) and `projects/` locally, lists project titles, directions and screen counts, and remembers the grant. An individual project folder containing `index.html` or `screens.html` also works.

Default data directories:

- macOS: `~/Library/Application Support/Open Design/namespaces/release-stable/data`
- Windows: `%APPDATA%/Open Design/namespaces/release-stable/data`
- Linux: `~/.config/Open Design/namespaces/release-stable/data`

`OPEN_DESIGN_DATA_DIR` overrides discovery on the execution host. Browser folder access is granted through the picker. If a remembered grant expires, select the folder again.

Sync copies the bundle into the Project's `design/`, supplies missing device frames and a design manifest, and creates a Git commit containing only managed design files. Existing staged product changes and unrelated design files are preserved. New Task worktrees inherit that committed specification. Unlink removes the association and leaves the design files available in Git.

The Header reports updates and provides **Sync**, **Open Design Studio**, and **Unlink**. Before Supervisor or Lead dispatch queues mail, Factory refreshes the source. For a client folder, it requests a fresh read from the Factory Header over Paseo RPC and waits for an acknowledgement. Keep Factory open on the design computer during dispatch. If the source is unavailable, dispatch refuses with `open-design-client-sync-required`; it queues no stale directive. Running agents read their local Git workspace and need no connection to Open Design.

Studio probes token-protected HTTP candidates first. `PASEO_FACTORY_PREVIEW_PORT` optionally selects a fixed port. If HTTP cannot be reached or started, the complete Studio opens inside Factory using an RPC bundle. The preview has no approval gate, so its decision buttons are disabled.

The public RPC methods use Paseo's lowercase naming: `factory.open_design.catalog`, `.export`, `.status`, `.sync`, `.unlink`, `.preview`.

Open Design MCP tools are independently optional: **Plugins → Helper MCP catalog → + Sync to Peer**. Discovery starts disabled. Project design bundles never enter Private vault.
