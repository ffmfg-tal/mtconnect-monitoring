# edge/ansible

Provisions the Ubuntu 24.04 NUC baseline and deploys the mtconnect stack.

## Usage

```bash
cp inventory.example.ini inventory.ini
# edit inventory.ini with your NUC hostname/IP and vault-sourced secrets
ansible-playbook -i inventory.ini playbook.yml --check  # dry-run
ansible-playbook -i inventory.ini playbook.yml          # apply
```

## What it configures

- **baseline**: essential packages, auditd, unattended-upgrades, SSH hardening, chrony, UFW deny-by-default + allow 22
- **podman**: podman + podman-compose + rootless prerequisites, lingering for mtconnect user
- **monitoring_vlan**: (optional) VLAN tagged interface via netplan
- **mtconnect_stack**: sync repo to /opt/mtconnect, systemd unit to run podman-compose on boot

## CMMC posture (Phase 1)

- FDE assumed pre-install (LUKS at Ubuntu install time)
- SSH keys only, password auth off
- auditd enabled with default rules
- UFW default-deny
- rootless containers
- monitoring VLAN keeps machine traffic off the main network
