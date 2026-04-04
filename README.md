# Syncthing Bridge for Obsidian

Manage Syncthing-powered remote vault sync from within Obsidian. Keep your vault alive on a remote server — it never goes "dead" when you close your laptop.

## Why

Obsidian vaults are local-first, which is great until you want AI agents (like Claude Code) editing your notes on a remote server, or you want your vault accessible 24/7 from anywhere. Syncthing handles encrypted peer-to-peer file sync. This plugin gives you visibility and control over that sync from inside Obsidian.

## What it does

- **Status bar** — icon + connected device count at a glance
- **Conflict resolution** — side-by-side diff view to keep current, keep conflict, keep both, or skip
- **Conflict file hiding** — `.sync-conflict-*` files are hidden from the file browser, managed through the resolver UI
- **Sync status command** — see all devices, folders, and connection state
- **Settings UI** — configure Syncthing API connection from Obsidian, with a test button

## Setup

### 1. Install Syncthing

**Mac:**
```bash
brew install syncthing
brew services start syncthing
```

**Remote server (e.g. Ubuntu):**

> Note: The official Syncthing apt repo currently only has v1.x. For v2.x, install from the GitHub release:

```bash
# Check https://github.com/syncthing/syncthing/releases for the latest version
curl -sLO https://github.com/syncthing/syncthing/releases/download/v2.0.15/syncthing-linux-amd64-v2.0.15.tar.gz
tar xzf syncthing-linux-amd64-v2.0.15.tar.gz
sudo cp syncthing-linux-amd64-v2.0.15/syncthing /usr/local/bin/
```

### 2. Make Syncthing persistent on the remote server

Create a systemd service so Syncthing survives reboots:

```bash
sudo tee /etc/systemd/system/syncthing@.service > /dev/null <<'EOF'
[Unit]
Description=Syncthing - Open Source Continuous File Synchronization for %i
After=network.target

[Service]
User=%i
ExecStart=/usr/local/bin/syncthing serve --no-browser --no-restart --logflags=0
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable syncthing@YOUR_USERNAME
sudo systemctl start syncthing@YOUR_USERNAME
```

Verify it's running:
```bash
sudo systemctl status syncthing@YOUR_USERNAME
```

### 3. Disable local discovery on the server (recommended)

Prevents other devices on the server's LAN from detecting Syncthing:

```bash
syncthing cli config options local-ann-enabled set false
```

### 4. Pair devices

Get device IDs:
```bash
# On each machine
syncthing cli show system | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])"
```

Add each device to the other:
```bash
# On Mac — add the remote server
syncthing cli config devices add --device-id REMOTE_DEVICE_ID --name my-server

# On server — add your Mac
syncthing cli config devices add --device-id MAC_DEVICE_ID --name macbook
```

### 5. Share a vault folder

```bash
# On Mac
mkdir -p ~/my-synced-vault
syncthing cli config folders add --id my-vault --path ~/my-synced-vault --label "My Vault"
syncthing cli config folders my-vault devices add --device-id REMOTE_DEVICE_ID

# On server
mkdir -p ~/my-vault
syncthing cli config folders add --id my-vault --path ~/my-vault --label "My Vault"
syncthing cli config folders my-vault devices add --device-id MAC_DEVICE_ID
```

### 6. Open the vault in Obsidian

Open `~/my-synced-vault` as a vault in Obsidian. Install this plugin and configure:

1. Go to **Settings → Community plugins → Syncthing Bridge**
2. Set the **API URL** (default `http://127.0.0.1:8384`)
3. Set the **API Key** — find it via `syncthing cli config gui apikey get` or in the Syncthing web UI under Actions → Settings
4. Hit **Test** to verify the connection

### 7. Access Syncthing web UI on the server (optional)

SSH tunnel the remote Syncthing UI to your local machine:
```bash
ssh -L 8385:localhost:8384 your-server
```
Then open `http://localhost:8385`.

## Plugin commands

| Command | Description |
|---------|-------------|
| **Show sync status** | Display connected devices and folder info |
| **Resolve sync conflicts** | Open side-by-side diff view for all conflicts |

## Plugin settings

| Setting | Default | Description |
|---------|---------|-------------|
| API URL | `http://127.0.0.1:8384` | Syncthing REST API endpoint |
| API Key | (empty) | Required — found in Syncthing GUI or via CLI |
| Poll interval | 30s | How often to check sync status |
| Conflict notifications | On | Show notices for `.sync-conflict-*` files |

## Security

- All Syncthing traffic is TLS-encrypted with mutual device authentication
- No cloud accounts or third-party services required
- Peer-to-peer: your data never touches a third-party server (relay servers only see encrypted traffic)
- Syncthing web UI binds to localhost only — access remote UI via SSH tunnel
- API key stays local to your machine
- Disable local discovery on servers to prevent LAN-level device detection

## Roadmap

- [x] Status bar with sync icon
- [x] Conflict resolution UI (side-by-side diff)
- [x] Hide conflict files from file browser
- [ ] Multi-vault management from one settings panel
- [ ] Device online/offline notifications
- [ ] Selective folder sync controls
- [ ] Pause/resume sync from Obsidian
