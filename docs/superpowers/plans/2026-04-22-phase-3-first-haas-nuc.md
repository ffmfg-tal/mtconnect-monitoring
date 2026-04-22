# Phase 3: First Haas on Real NUC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a live Haas VF-2 NGC machine through the full stack — Haas adapter → cppagent → forwarder → cloud Worker → read API returning real OEE data.

**Architecture:** Haas's built-in MTConnect adapter (enabled via Setting 143) speaks SHDR on port 7878. cppagent connects to it over the monitoring VLAN. The edge forwarder long-polls cppagent and POSTs to the deployed Cloudflare Worker. All business logic (state machine, rollups, alerts) runs in the cloud.

**Tech Stack:** Haas NGC MTConnect adapter, cppagent 2.7, Python 3.12 edge forwarder, Cloudflare Workers + D1, Hono, wrangler CLI, Ansible, podman-compose, Unifi UDB-IoT bridge, Ubuntu 24.04 LTS

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `edge/cppagent/devices/haas-ngc-vf2.xml` | **Create** | Haas VF-2 device definition template |
| `edge/cppagent/Devices.prod.xml` | **Create** | Production Devices.xml (haas01 only, no simulator) |
| `edge/cppagent/agent.prod.cfg.j2` | **Create** | Jinja2 template for production agent.cfg (adapter IP as var) |
| `edge/compose/compose.prod.yml` | **Create** | Production compose stack (no simulator service) |
| `edge/ansible/roles/mtconnect_stack/tasks/main.yml` | **Modify** | Use `compose_file` var; template agent.cfg; use `Devices.prod.xml` |
| `edge/ansible/roles/mtconnect_stack/templates/agent.cfg.j2` | **Create** | Jinja2 agent.cfg template (symlink from cppagent dir) |
| `edge/ansible/group_vars/nucs.yml` | **Create** | Per-group vars: VLAN IDs, compose_file, haas01_adapter_ip |
| `cloud/wrangler.jsonc` | **Modify** | Fill in real D1 database_id after `wrangler d1 create` |

---

### Task 1: Haas VF-2 Device XML Template

Haas NGC's built-in MTConnect adapter exposes a fixed set of DataItems on port 7878. The template below covers the DataItems that Haas NGC emits. DataItem `id` attributes use a machine-prefix (`haas01_`) to avoid collision when multiple devices share one cppagent.

**Files:**
- Create: `edge/cppagent/devices/haas-ngc-vf2.xml`

- [ ] **Step 1: Create the Haas device definition**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
  Haas VF-2 NGC device template.
  Adapter speaks SHDR on port 7878 (native MTConnect, Setting 143 = 1).
  DataItem id prefix matches the <Device uuid> so multi-device cppagent stays collision-free.
  To add a second Haas: copy this file, change uuid + all id attributes, add Adapters block.
-->
<MTConnectDevices xmlns="urn:mtconnect.org:MTConnectDevices:2.7"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xsi:schemaLocation="urn:mtconnect.org:MTConnectDevices:2.7 http://schemas.mtconnect.org/schemas/MTConnectDevices_2.7.xsd">
  <Header creationTime="2026-04-22T00:00:00Z" sender="localhost"
          instanceId="1" bufferSize="131072" version="2.7"/>
  <Devices>
    <Device id="haas01" name="Haas01" uuid="HAAS-VF2-001">
      <Description manufacturer="Haas Automation" model="VF-2" serialNumber=""/>
      <DataItems>
        <DataItem category="EVENT" id="haas01_avail" type="AVAILABILITY"/>
      </DataItems>
      <Components>
        <Controller id="haas01_ctrl" name="controller">
          <DataItems>
            <DataItem category="EVENT"     id="haas01_mode"   type="CONTROLLER_MODE"/>
            <DataItem category="EVENT"     id="haas01_estop"  type="EMERGENCY_STOP"/>
            <DataItem category="CONDITION" id="haas01_system" type="SYSTEM"/>
            <DataItem category="CONDITION" id="haas01_logic"  type="LOGIC_PROGRAM"/>
            <DataItem category="CONDITION" id="haas01_motion" type="MOTION_PROGRAM"/>
          </DataItems>
          <Components>
            <Path id="haas01_path" name="path">
              <DataItems>
                <DataItem category="EVENT"  id="haas01_exec"   type="EXECUTION"/>
                <DataItem category="EVENT"  id="haas01_prog"   type="PROGRAM"/>
                <DataItem category="EVENT"  id="haas01_tool"   type="TOOL_NUMBER"/>
                <DataItem category="EVENT"  id="haas01_part"   type="PART_COUNT" subType="ALL"/>
                <DataItem category="SAMPLE" id="haas01_feed"   type="PATH_FEEDRATE" units="MILLIMETER/SECOND"/>
                <DataItem category="SAMPLE" id="haas01_feed_o" type="PATH_FEEDRATE_OVERRIDE" units="PERCENT"/>
              </DataItems>
            </Path>
          </Components>
        </Controller>
        <Axes id="haas01_axes" name="base">
          <Components>
            <Rotary id="haas01_spindle" name="C">
              <DataItems>
                <DataItem category="SAMPLE" id="haas01_rpm"          type="ROTARY_VELOCITY"         units="REVOLUTION/MINUTE"/>
                <DataItem category="SAMPLE" id="haas01_spindle_load" type="LOAD"                    units="PERCENT"/>
                <DataItem category="SAMPLE" id="haas01_spindle_o"    type="ROTARY_VELOCITY_OVERRIDE" units="PERCENT"/>
              </DataItems>
            </Rotary>
          </Components>
        </Axes>
      </Components>
    </Device>
  </Devices>
</MTConnectDevices>
```

- [ ] **Step 2: Commit**

```bash
git add edge/cppagent/devices/haas-ngc-vf2.xml
git commit -m "feat(cppagent): Haas VF-2 NGC device XML template"
```

---

### Task 2: Production Devices.xml and agent.cfg Template

In dev, `Devices.xml` holds the Mazak01 simulator device. In production it holds the real fleet. Rather than modifying `Devices.xml` in place (which would break simulator tests), we keep both and point the Ansible role at the production variants.

`agent.prod.cfg.j2` is a Jinja2 template so Ansible can inject the VLAN IP without editing the file manually.

**Files:**
- Create: `edge/cppagent/Devices.prod.xml`
- Create: `edge/cppagent/agent.prod.cfg.j2`

- [ ] **Step 1: Create production Devices.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
  Production Devices.xml — real fleet only, no simulator.
  Add new machines here as a PR; also add corresponding Adapters block to agent.prod.cfg.j2.
-->
<MTConnectDevices xmlns="urn:mtconnect.org:MTConnectDevices:2.7"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  xsi:schemaLocation="urn:mtconnect.org:MTConnectDevices:2.7 http://schemas.mtconnect.org/schemas/MTConnectDevices_2.7.xsd">
  <Header creationTime="2026-04-22T00:00:00Z" sender="localhost"
          instanceId="1" bufferSize="131072" version="2.7"/>
  <Devices>
    <!-- Phase 3: Haas VF-2 #1 -->
    <Device id="haas01" name="Haas01" uuid="HAAS-VF2-001">
      <Description manufacturer="Haas Automation" model="VF-2" serialNumber=""/>
      <DataItems>
        <DataItem category="EVENT" id="haas01_avail" type="AVAILABILITY"/>
      </DataItems>
      <Components>
        <Controller id="haas01_ctrl" name="controller">
          <DataItems>
            <DataItem category="EVENT"     id="haas01_mode"   type="CONTROLLER_MODE"/>
            <DataItem category="EVENT"     id="haas01_estop"  type="EMERGENCY_STOP"/>
            <DataItem category="CONDITION" id="haas01_system" type="SYSTEM"/>
            <DataItem category="CONDITION" id="haas01_logic"  type="LOGIC_PROGRAM"/>
            <DataItem category="CONDITION" id="haas01_motion" type="MOTION_PROGRAM"/>
          </DataItems>
          <Components>
            <Path id="haas01_path" name="path">
              <DataItems>
                <DataItem category="EVENT"  id="haas01_exec"   type="EXECUTION"/>
                <DataItem category="EVENT"  id="haas01_prog"   type="PROGRAM"/>
                <DataItem category="EVENT"  id="haas01_tool"   type="TOOL_NUMBER"/>
                <DataItem category="EVENT"  id="haas01_part"   type="PART_COUNT" subType="ALL"/>
                <DataItem category="SAMPLE" id="haas01_feed"   type="PATH_FEEDRATE" units="MILLIMETER/SECOND"/>
                <DataItem category="SAMPLE" id="haas01_feed_o" type="PATH_FEEDRATE_OVERRIDE" units="PERCENT"/>
              </DataItems>
            </Path>
          </Components>
        </Controller>
        <Axes id="haas01_axes" name="base">
          <Components>
            <Rotary id="haas01_spindle" name="C">
              <DataItems>
                <DataItem category="SAMPLE" id="haas01_rpm"          type="ROTARY_VELOCITY"          units="REVOLUTION/MINUTE"/>
                <DataItem category="SAMPLE" id="haas01_spindle_load" type="LOAD"                     units="PERCENT"/>
                <DataItem category="SAMPLE" id="haas01_spindle_o"    type="ROTARY_VELOCITY_OVERRIDE"  units="PERCENT"/>
              </DataItems>
            </Rotary>
          </Components>
        </Axes>
      </Components>
    </Device>
  </Devices>
</MTConnectDevices>
```

- [ ] **Step 2: Create the Jinja2 agent config template**

```
{# edge/cppagent/agent.prod.cfg.j2 #}
Devices = Devices.xml
SchemaVersion = 2.7
WorkerThreads = 4
MonitorConfigFiles = yes
Port = 5000
ServerIp = 0.0.0.0
JsonVersion = 2
BufferSize = 17
MaxAssets = 1024
DisableAgentDevice = false
Validation = true

logger_config {
  output = cout
  level = warn
}

{# One Adapters block per machine.  haas01_adapter_ip comes from group_vars/nucs.yml. #}
Adapters {
  Haas01 {
    Host = {{ haas01_adapter_ip }}
    Port = 7878
    Device = Haas01
    ReconnectInterval = 10000
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add edge/cppagent/Devices.prod.xml edge/cppagent/agent.prod.cfg.j2
git commit -m "feat(cppagent): production Devices.xml + Jinja2 agent.cfg template for Haas01"
```

---

### Task 3: Production Compose Stack (No Simulator)

The dev `compose.yml` starts a Ruby simulator. The production stack talks directly to the Haas adapter on the monitoring VLAN; cppagent's `Adapters` block handles reconnect.

**Files:**
- Create: `edge/compose/compose.prod.yml`

- [ ] **Step 1: Create the production compose file**

```yaml
# Production stack — no simulator service.
# cppagent connects to real machine adapters via monitoring VLAN.
# Forwarder reads MTC_CLOUD_URL + MTC_EDGE_SECRET from /opt/mtconnect/compose/.env (written by Ansible).
version: "3.9"

services:
  cppagent:
    image: mtconnect/agent:2.7
    volumes:
      - ../cppagent:/mtconnect/config:ro
    ports:
      - "127.0.0.1:5000:5000"
    networks: [mtc]
    restart: unless-stopped

  forwarder:
    build:
      context: ../forwarder
    depends_on: [cppagent]
    environment:
      MTC_AGENT_URL: http://cppagent:5000
      MTC_CLOUD_URL: ${MTC_CLOUD_URL:?set MTC_CLOUD_URL in .env}
      MTC_EDGE_SECRET: ${MTC_EDGE_SECRET:?set MTC_EDGE_SECRET in .env}
      MTC_BUFFER_PATH: /var/lib/mtconnect/forwarder.sqlite
      MTC_POLL_INTERVAL_S: "1.0"
      MTC_FORWARD_INTERVAL_S: "1.0"
      MTC_FORWARD_BATCH: "500"
    volumes:
      - forwarder-data:/var/lib/mtconnect
    networks: [mtc]
    restart: unless-stopped

networks:
  mtc:
    driver: bridge

volumes:
  forwarder-data:
```

- [ ] **Step 2: Commit**

```bash
git add edge/compose/compose.prod.yml
git commit -m "feat(compose): production stack without simulator"
```

---

### Task 4: Update Ansible mtconnect_stack Role

The role currently syncs files then starts `compose.yml`. We need it to:
1. Template `agent.prod.cfg.j2` → `/opt/mtconnect/cppagent/agent.cfg` (overwriting the dev config)
2. Copy `Devices.prod.xml` → `/opt/mtconnect/cppagent/Devices.xml`
3. Start `compose_file` (variable, default `compose.yml`) instead of hardcoded compose.yml

**Files:**
- Modify: `edge/ansible/roles/mtconnect_stack/tasks/main.yml`

- [ ] **Step 1: Replace the task file**

```yaml
---
- name: Sync stack files to /opt/mtconnect
  ansible.builtin.synchronize:
    src: "{{ playbook_dir }}/../"
    dest: /opt/mtconnect/
    rsync_opts:
      - "--exclude=.git"
      - "--exclude=ansible"
      - "--exclude=forwarder/tests"
  become: true

- name: Template production agent.cfg from Jinja2 template
  ansible.builtin.template:
    src: "{{ playbook_dir }}/../cppagent/agent.prod.cfg.j2"
    dest: /opt/mtconnect/cppagent/agent.cfg
    owner: "{{ mtconnect_user }}"
    group: "{{ mtconnect_user }}"
    mode: "0644"

- name: Activate production Devices.xml (replace dev Devices.xml)
  ansible.builtin.copy:
    src: /opt/mtconnect/cppagent/Devices.prod.xml
    dest: /opt/mtconnect/cppagent/Devices.xml
    owner: "{{ mtconnect_user }}"
    group: "{{ mtconnect_user }}"
    mode: "0644"
    remote_src: yes

- name: Ensure stack owned by mtconnect
  ansible.builtin.file:
    path: /opt/mtconnect
    owner: "{{ mtconnect_user }}"
    group: "{{ mtconnect_user }}"
    recurse: yes

- name: Ensure .env present
  ansible.builtin.copy:
    dest: /opt/mtconnect/compose/.env
    content: |
      MTC_CLOUD_URL={{ mtc_cloud_url }}
      MTC_EDGE_SECRET={{ mtc_edge_secret }}
    owner: "{{ mtconnect_user }}"
    group: "{{ mtconnect_user }}"
    mode: "0600"

- name: Deploy systemd unit
  ansible.builtin.copy:
    dest: /etc/systemd/system/mtconnect-stack.service
    content: |
      [Unit]
      Description=MTConnect edge stack (podman-compose)
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      User={{ mtconnect_user }}
      WorkingDirectory=/opt/mtconnect/compose
      ExecStart=/usr/bin/podman-compose -f {{ compose_file | default('compose.yml') }} up
      ExecStop=/usr/bin/podman-compose -f {{ compose_file | default('compose.yml') }} down
      Restart=on-failure
      RestartSec=10

      [Install]
      WantedBy=multi-user.target
    mode: "0644"
  notify: reload systemd

- name: Enable mtconnect-stack
  ansible.builtin.service:
    name: mtconnect-stack
    state: started
    enabled: yes
```

- [ ] **Step 2: Commit**

```bash
git add edge/ansible/roles/mtconnect_stack/tasks/main.yml
git commit -m "feat(ansible): template agent.cfg + configurable compose_file var in mtconnect_stack role"
```

---

### Task 5: Ansible Inventory + Group Vars

`inventory.ini` is gitignored (contains real IPs). `group_vars/nucs.yml` is committed with placeholder values — real secret is vault-encrypted.

**Files:**
- Create: `edge/ansible/group_vars/nucs.yml`
- Verify: `edge/ansible/.gitignore` excludes `inventory.ini` and vault files

- [ ] **Step 1: Create group_vars directory and vars file**

```bash
mkdir -p edge/ansible/group_vars
```

```yaml
# edge/ansible/group_vars/nucs.yml
# Committed with placeholder values.
# mtc_edge_secret must be set via vault or --extra-vars at deploy time.

compose_file: compose.prod.yml

# Haas01 adapter — IP assigned by Unifi to UDB-IoT bridge on monitoring VLAN
# Update this to the real IP before running Ansible.
haas01_adapter_ip: "192.168.30.11"

# Cloud Worker URL — fill in after wrangler deploy
mtc_cloud_url: "https://mtconnect-collector.ACCOUNT.workers.dev"

# Secret — provide via: ansible-playbook ... --extra-vars "mtc_edge_secret=SECRET"
# Or: ansible-vault encrypt_string 'SECRET' --name 'mtc_edge_secret' >> group_vars/nucs.yml
mtc_edge_secret: "REPLACE_VIA_VAULT_OR_EXTRA_VARS"

# VLAN interface created by monitoring_vlan role (format: LINK.VLAN_ID)
monitoring_vlan_interface: "enp3s0.30"
monitoring_vlan_id: 30
monitoring_vlan_link: "enp3s0"
```

- [ ] **Step 2: Create .gitignore for ansible secrets**

```
# edge/ansible/.gitignore
inventory.ini
*.vault.yml
vault_password
```

- [ ] **Step 3: Commit**

```bash
git add edge/ansible/group_vars/nucs.yml edge/ansible/.gitignore
git commit -m "feat(ansible): group_vars for Haas01 production deployment"
```

---

### Task 6: Cloud Worker Deployment

These are operator steps — run from the developer workstation, not the NUC. `npx wrangler` works from Windows PowerShell or bash. You'll need to be logged in to Cloudflare (`npx wrangler login`).

**Files:**
- Modify: `cloud/wrangler.jsonc` (fill in real database_id)

- [ ] **Step 1: Create the D1 production database**

```bash
cd cloud
npx wrangler d1 create mtconnect
```

Expected output:
```
✅ Successfully created DB 'mtconnect' in region ENAM
Created your new D1 database.

[[d1_databases]]
binding = "DB"
database_name = "mtconnect"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` value.

- [ ] **Step 2: Update wrangler.jsonc with the real database_id**

Open `cloud/wrangler.jsonc` and replace `"REPLACE_AT_DEPLOY"` in the top-level (non-staging) `d1_databases` block with the ID from Step 1.

- [ ] **Step 3: Apply migrations to production D1**

```bash
npx wrangler d1 execute mtconnect --file migrations/0001_v2_init.sql --remote
npx wrangler d1 execute mtconnect --file migrations/0002_processor_cursor_state.sql --remote
```

Both should print `🌀 Executing on remote database mtconnect` with no errors.

- [ ] **Step 4: Generate a strong edge secret**

```bash
openssl rand -hex 32
```

Save this value — it goes into both the Worker secret and the NUC's `.env`.

- [ ] **Step 5: Set Worker secrets**

```bash
npx wrangler secret put EDGE_SHARED_SECRET
# Paste the hex string from Step 4 when prompted

# Optional but recommended:
npx wrangler secret put SLACK_WEBHOOK_URL
# Paste the Slack incoming webhook URL when prompted
```

- [ ] **Step 6: Deploy the Worker**

```bash
npx wrangler deploy
```

Expected output:
```
✅ Deployed mtconnect-collector
https://mtconnect-collector.ACCOUNT.workers.dev
```

- [ ] **Step 7: Verify health endpoint**

```bash
curl https://mtconnect-collector.ACCOUNT.workers.dev/health
```

Expected: `{"ok":true,"service":"mtconnect-collector"}`

- [ ] **Step 8: Commit wrangler.jsonc with real database_id**

```bash
cd ..
git add cloud/wrangler.jsonc
git commit -m "chore(cloud): fill in production D1 database_id"
```

---

### Task 7: Haas NGC MTConnect Configuration (Machine-Side)

This is performed at the Haas control panel — no code changes. The setting enables the built-in MTConnect adapter on TCP port 7878.

- [ ] **Step 1: Enable MTConnect on the Haas**

On the Haas control:
1. Press **Settings** (wrench icon)
2. Search for setting **143** (`MTCONNECT`)
3. Set value to **1** (Enabled)
4. Press **Write** to save

- [ ] **Step 2: Verify adapter is listening**

From any machine on the monitoring VLAN that has `nc` or `curl`:

```bash
# Replace 192.168.30.11 with the Haas's actual VLAN IP
curl http://192.168.30.11:7878/probe
```

Expected: XML response starting with `<MTConnectDevices ...>` containing Haas-specific DataItems.

- [ ] **Step 3: Record the actual Haas adapter DataItem IDs**

The Haas adapter uses its own `id` and `name` attributes which may differ from the template in Task 1. Compare the actual `/probe` output against `edge/cppagent/devices/haas-ngc-vf2.xml` and update if needed. The cppagent `Devices.xml` must match the adapter's `id` attributes exactly.

---

### Task 8: Unifi UDB-IoT Bridge Setup (Network)

The UDB-IoT is a $45 Wi-Fi-to-Ethernet bridge. Each Haas machine gets one. It appears as a wired client to the machine and as a Wi-Fi client to the Unifi AP, tagged on the monitoring VLAN.

- [ ] **Step 1: Adopt the UDB-IoT into Unifi Network**

1. Power the UDB-IoT (USB-C, 5W)
2. Connect it to the Unifi management Wi-Fi (2.4 GHz) following the hardware reset sequence in the UDB-IoT quick-start guide
3. Adopt in Unifi Network → Devices list

- [ ] **Step 2: Assign the monitoring VLAN**

In Unifi Network:
1. Open the UDB-IoT device → Settings → Network
2. Set **Wired Network** to the monitoring VLAN (VLAN 30 at FFMFG)
3. Set **Wireless Network** to the monitoring SSID (the same SSID the NUC uses for management, or a dedicated monitoring SSID if already configured)
4. Apply

- [ ] **Step 3: Connect the Haas Ethernet port to the UDB-IoT**

Plug the UDB-IoT's Ethernet port into the Haas Ethernet jack (usually on the rear of the control cabinet).

- [ ] **Step 4: Record the Haas's VLAN IP**

In Unifi Network, the UDB-IoT client list should show the Haas's DHCP lease. Note the IP — this is `haas01_adapter_ip` in `group_vars/nucs.yml`.

Update the placeholder:
```bash
# In edge/ansible/group_vars/nucs.yml:
# haas01_adapter_ip: "192.168.30.XX"   ← fill in real IP
```

---

### Task 9: NUC OS Installation

This is a one-time manual step. The NUC runs Ubuntu 24.04 LTS with full-disk encryption (FDE).

- [ ] **Step 1: Install Ubuntu 24.04 Server**

Boot from USB. Choose:
- **Encrypted LVM** at storage setup screen
- Set a strong LUKS passphrase (store in Bitwarden)
- Hostname: `mtc-nuc-01`
- Username: `tal` (or your admin user)
- **Enable OpenSSH server** during install

- [ ] **Step 2: Configure auto-unlock for headless operation (optional)**

If the NUC must reboot unattended, configure Clevis + Tang or a Mandos server for network-bound disk encryption unlock. Skip for Phase 3 if physical access is acceptable on reboot.

- [ ] **Step 3: Add SSH public key**

From your workstation:
```bash
ssh-copy-id tal@NUC_IP
```

Verify:
```bash
ssh tal@NUC_IP "echo ok"
```

- [ ] **Step 4: Note the NUC's management IP**

Add it to `edge/ansible/inventory.ini` (not committed):

```ini
[nucs]
nuc-shop-1 ansible_host=10.0.20.10 ansible_user=tal
```

Replace `10.0.20.10` with the actual NUC management IP.

---

### Task 10: Ansible Provisioning Run

Runs from the developer workstation. Requires `ansible` installed locally (`pip install ansible`).

- [ ] **Step 1: Populate the real secrets**

Edit `edge/ansible/group_vars/nucs.yml`:
- Set `haas01_adapter_ip` to the Haas's real VLAN IP (from Task 8 Step 4)
- Set `mtc_cloud_url` to the deployed Worker URL (from Task 6 Step 6)

Confirm the monitoring VLAN interface name on the NUC:
```bash
ssh tal@NUC_IP "ip link show"
```

Update `monitoring_vlan_link` and `monitoring_vlan_interface` in `group_vars/nucs.yml` if the NIC name differs from `enp3s0`.

- [ ] **Step 2: Dry-run first**

```bash
cd edge/ansible
ansible-playbook -i inventory.ini playbook.yml --check \
  --extra-vars "mtc_edge_secret=THE_HEX_SECRET_FROM_TASK_6"
```

Expected: green/yellow output, no red failures. Fix any errors before proceeding.

- [ ] **Step 3: Run for real**

```bash
ansible-playbook -i inventory.ini playbook.yml \
  --extra-vars "mtc_edge_secret=THE_HEX_SECRET_FROM_TASK_6"
```

Expected: all tasks OK/changed, no failures.

- [ ] **Step 4: Verify the stack started**

```bash
ssh tal@NUC_IP "sudo systemctl status mtconnect-stack"
```

Expected: `Active: active (running)`.

```bash
ssh tal@NUC_IP "sudo -u mtconnect podman-compose -f /opt/mtconnect/compose/compose.prod.yml logs --tail=50"
```

Expected: forwarder logs showing `Posted probe OK` and `Forwarded N observations`.

---

### Task 11: End-to-End Smoke Test

Performed after Ansible completes and the stack is running. Tests the full data path from Haas → cloud.

- [ ] **Step 1: cppagent serving real data**

```bash
# From NUC or monitoring VLAN:
curl http://localhost:5000/probe
```

Expected: `<MTConnectDevices>` with `<Device uuid="HAAS-VF2-001" ...>` containing the Haas DataItems.

```bash
curl "http://localhost:5000/sample?from=1&count=100"
```

Expected: `<MTConnectStreams>` with observations; EXECUTION value should match current machine state (READY if powered, UNAVAILABLE if off).

- [ ] **Step 2: Probe received by cloud**

```bash
curl https://mtconnect-collector.ACCOUNT.workers.dev/machines
```

Expected:
```json
[{"uuid":"HAAS-VF2-001","name":"Haas01","last_observation_ts":"2026-04-22T..."}]
```

- [ ] **Step 3: Observations flowing**

```bash
curl https://mtconnect-collector.ACCOUNT.workers.dev/machines/HAAS-VF2-001/current
```

Expected: array of `{data_item_id, type, category, ...}` objects with timestamps within the last 30 seconds.

- [ ] **Step 4: State machine processing**

Wait ~90 seconds for the 1-minute cron to fire twice. Then:

```bash
TODAY=$(date -u +%Y-%m-%d)
curl "https://mtconnect-collector.ACCOUNT.workers.dev/machines/HAAS-VF2-001/utilization?date=${TODAY}"
```

Expected:
```json
{"date":"2026-04-22","availability_pct":100.0,"utilization_pct":0.0,"note":"..."}
```

(Utilization 0 = machine is READY/OFFLINE, not ACTIVE — this is correct when idle.)

- [ ] **Step 5: Run a program, verify ACTIVE state**

At the Haas: load a program and run it (any test program is fine). After ~10 seconds:

```bash
curl https://mtconnect-collector.ACCOUNT.workers.dev/machines/HAAS-VF2-001/current \
  | jq '.[] | select(.type == "EXECUTION")'
```

Expected: `"value_str":"ACTIVE"`.

Wait 2+ minutes, then re-check utilization — `utilization_pct` should be non-zero.

- [ ] **Step 6: Alert test — idle_during_shift**

The `idle_during_shift` alert fires after 20 minutes of non-ACTIVE state during shift hours. To test immediately without waiting, verify the alert rule fires in unit tests (already passing from Phase 1). For integration validation, leave the machine READY for 25 minutes and check:

```bash
curl https://mtconnect-collector.ACCOUNT.workers.dev/alerts
```

Expected: alert with `rule="idle_during_shift"` and `machine_uuid="HAAS-VF2-001"`.

- [ ] **Step 7: Commit final group_vars with real (non-secret) values**

The `mtc_edge_secret` is provided via `--extra-vars` at deploy time and is not committed. The non-secret vars are safe to commit.

```bash
git add edge/ansible/group_vars/nucs.yml
git commit -m "chore(ansible): Haas01 real VLAN IP + cloud URL for Phase 3 deployment"
```

---

## Phase 3 Done Criteria

- [ ] `/machines` returns Haas01 with a recent `last_observation_ts`
- [ ] `/machines/HAAS-VF2-001/current` returns all DataItems with live values
- [ ] Running a program at the Haas updates EXECUTION to ACTIVE within 10 seconds
- [ ] Utilization endpoint returns non-zero `utilization_pct` after a program run
- [ ] `idle_during_shift` alert fires when machine is idle during production hours
- [ ] NUC reboots cleanly and the stack restarts via systemd

## What Phase 3 Does NOT Include

- Okuma / Siemens machines (Phase 4 and 5)
- MES tile integration — `shop-floor-mes` reads from this API; wire up the Haas tile after the API is confirmed live
- R2 archival — 90-day D1 retention is fine for Phase 3
- cloudflared inbound tunnel — the forwarder makes outbound HTTPS POSTs only; no inbound connections needed
- Per-machine alert threshold tuning (Phase 6)
