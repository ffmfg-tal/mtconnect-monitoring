# Vendor verification email templates

Before deploying the MTConnect stack, confirm option/license status on each controller so you don't discover a licensing gap on install day. Send these to the relevant distributor contact, or adapt for internal use.

Tune the tone and specifics to your shop. The templates below are written for a read-only Phase 1 deployment (telemetry only — no DNC, no NC-side writes). If you're planning DNC or machine writes, add the appropriate scope to the body.

## Template 1 — Haas Automation / Haas Factory Outlet

```
Subject: MTConnect verification for Haas NGC machines

Hi [Name],

We're deploying an in-house read-only machine monitoring system using
MTConnect, and I need to verify the status of our Haas NGC machines before
we cable them into the monitoring VLAN. Models and serials to follow.

A few specific items I'd appreciate confirmation on:

- MTConnect activation status on each serial. On NGC this has historically
  been Setting 143 (or current equivalent) — can you confirm it's enabled,
  or tell me if there's an activation fee to turn it on?
- Minimum NGC software version required for MTConnect 1.7 or later. What
  version are our machines on, and is an update recommended?
- Confirmation that MTConnect on Haas NGC is truly native — i.e., the
  control itself serves the MTConnect agent on ports 5000/5001 and no
  separate adapter PC is required.
- Ethernet configuration guidance: static IP assignment procedure, and the
  exact ports we need open between the machine and our edge collector
  (I have 5000/5001 noted).
- Any Haas-published network or IT integration guide for MTConnect
  deployments — would prefer official docs over forum threads.

Happy to schedule a quick call if easier. Thanks for the help.

[Sign-off]
```

## Template 2 — Okuma distributor (e.g., Gosiger)

```
Subject: Okuma MTConnect / App Suite license check — OSP-P machines

Hi [Name],

We're standing up a read-only machine monitoring platform based on
MTConnect, and I need to verify the Okuma side before we integrate our
OSP-P machine(s). Model and serial to follow.

Items I need confirmed:

- Okuma App Suite MTConnect adapter license status on our serial(s). If
  it's not licensed, please send pricing, the installation procedure, and
  compatibility notes against our installed OSP-P version.
- Where the adapter installs: directly on the OSP-P HMI PC, or on a
  separate Windows host? If HMI-resident, what are the HMI PC specs and
  typical free disk space we should expect?
- THINC API access as a fallback path — licensing requirements, SDK /
  documentation access, and whether it can coexist with App Suite.
- Any Okuma-published MTConnect data dictionary for OSP-P — specifically
  the list of DataItems the adapter exposes (execution, program, spindle
  load, feedrate, alarms, tool number, part count are the ones we care
  about for OEE).
- Network configuration recommendations for connecting the HMI / adapter
  host to a dedicated monitoring VLAN.

Our goal is Phase 1 read-only telemetry only — no DNC, no NC-side writes.
Thanks in advance.

[Sign-off]
```

## Template 3 — DN Solutions distributor (e.g., Ellison Technologies) for Siemens 840D sl

```
Subject: Sinumerik OPC UA license verification — DVF 5000 with Siemens control

Hi [Name],

We're deploying read-only machine monitoring and I need to verify the
Siemens / DN Solutions side on our DVF 5000 machines (Sinumerik Operate
/ 840D sl). Serials to follow.

Please confirm per serial:

- Sinumerik Operate software version. We need V4.8 or later for solid OPC
  UA Server support — what are our machines actually running?
- SINUMERIK OPC UA Server license activation status. This is typically
  ordered as "ACCESS MYMACHINE /OPC UA" or the newer "SINUMERIK Integrate
  Run MyRobot / OPC UA" bundle. Siemens SKU references seen in the wild:
  6FC5800-0AP67-0YB0 and 6FC5800-0BP67-0YB0 — please confirm the current
  SKU for this DVF vintage.
- If OPC UA Server is not activated: license cost and activation procedure
  (my understanding is it's a license key entered via the service /
  licensing menu).
- Any DN-specific guidance or restrictions for third-party OPC UA /
  MTConnect integrations on the DVF 5000.
- Network config recommendations: static IP on our monitoring VLAN,
  firewall port 4840 open to the edge collector only.
- If OPC UA is unavailable for any reason, what alternative read paths
  does DN recommend — MCIS, NETservice, or something else?

Thanks — happy to jump on a call.

[Sign-off]
```

## Template 4 — Internal checklist for controls / IT tech

```
Subject: Pre-deploy verification checklist — shop floor machine monitoring

Hey,

Before the edge NUC shows up for the MTConnect monitoring rollout, please
run through the following on the floor. Most of this is quick but I'd
rather find surprises now than on install day.

Machines in scope: [list]

- Assign static IPs on the new shop-floor monitoring VLAN for each
  machine above. Send me the IP map when done.
- From a laptop on the edge NUC subnet, ping each assigned IP and confirm
  cables are clean (no flaps, no errors).
- Port probes from that subnet:
  - Haas:    nmap -p 5000,5001 <haas-ip>
  - Siemens: nmap -p 4840      <dvf-ip>      (Sinumerik OPC UA)
  - Okuma:   nmap -p 5000      <okuma-ip>    (only if App Suite adapter
             is already running)
- Document current firmware / control software version for each machine
  (photo of the About screen is fine — label it with the asset tag).
- Confirm each machine's Ethernet port is patched into the monitoring
  VLAN switch (not the office VLAN, not an orphan run).
- Confirm the shop-floor network cabinet has rack / shelf space for:
  edge NUC, a small managed switch, and a UPS.
- Confirm cable runs from that cabinet to each machine's Ethernet port
  are in place. If any are missing, estimate length needed and send me
  the list.
- NTP: confirm the monitoring VLAN can reach pool.ntp.org (or point me
  at an internal NTP source if you'd rather we use that).
- Outbound internet: confirm the VLAN is locked down so only
  *.cloudflare.com and pool.ntp.org egress is allowed. Everything else
  blocked by design.

Thanks.

[Sign-off]
```
