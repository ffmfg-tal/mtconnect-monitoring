# Edge box hardware guidance

Recommendations for the shop-floor edge box that hosts the MTConnect stack (cppagent + Python collector + Cloudflare Tunnel + podman-compose). Written for a deployment of 5–15 machines.

## Three tiers

**Budget (~$500-$600): Beelink SER5 MAX or SER6**
- Ryzen 5 5625U / 7 6800H, 16 GB DDR4, 500 GB NVMe
- Single 2.5GbE, HDMI, consumer-grade mini PC
- Fine for Phase 1 (5 machines). Caveat: consumer SSD, single NIC, no vPro/AMT remote management. Verify current SKU — Beelink refreshes frequently.

**Recommended (~$900-$1,100): Dell OptiPlex Micro 7010/7020 Plus or Lenovo ThinkCentre M90q Gen 5**
- Intel Core i5-13500T or i5-14500T, 16–32 GB DDR5, 512 GB – 1 TB NVMe
- vPro/AMT out-of-band management (useful when the box is in a locked cabinet on the floor)
- Single 1GbE onboard; add a USB 2.5GbE adapter or a low-profile Intel i225/i226 NIC if the chassis allows
- Business-class thermals, 3-year Dell ProSupport available, TPM 2.0 for LUKS/CMMC
- **This is the sweet spot.** Buy refurb from Dell Outlet or Lenovo Campus for ~$800.

**Premium (~$1,400-$1,800): Protectli VP6630/VP6650 or SuperMicro E302-12D**
- Intel i5-1235U or Xeon D-1718T, 16–32 GB ECC (SuperMicro), 500 GB – 1 TB NVMe
- 4–6× Intel i225/i226 2.5GbE NICs, fanless, industrial temp range
- Overkill for compute but appropriate if you want fanless, multi-NIC, and coreboot (Protectli). SuperMicro E302 gets you ECC RAM, which matters more at 15+ machines.

## Storage

For a ~30-day rolling SQLite buffer with mostly sequential appends, a quality consumer NVMe (Samsung 990 Pro, WD SN770/SN850X, Crucial T500) is fine. Back-of-envelope writes: 15 machines × 1 sample/sec × ~200 bytes × 86,400 s ≈ 260 MB/day raw — well under 1 TB TBW over the SSD's life.

Upgrade to **DRAM-cached + power-loss-protected** drives (Micron 7450 Pro, Samsung PM9A3, Kingston DC600M) only if you scale to heavier write workloads (raw high-frequency variables, longer retention). PLP matters more than DRAM cache here — a dirty shutdown can corrupt SQLite WAL files. With a UPS (see below), consumer NVMe is acceptable.

## Networking: one NIC or two?

**Two NICs.** Put the edge box between your shop LAN (WAN-side, internet + Cloudflare Tunnel egress) and an isolated machine-monitoring VLAN/subnet. Benefits:

- Host-based firewall enforcement between CNC controllers and the corporate network (CMMC-friendly segmentation).
- Ability to proxy/NAT MTConnect traffic rather than trunking CNC VLANs into broader infrastructure.
- Clean separation if a Siemens 840D or Haas controller misbehaves on the wire.

A single trunk port works but concentrates trust on switch ACLs. Two NICs is the more defensible architecture for CMMC Level 2.

## Managed switch

**Yes.** Recommended: **Netgear GS108Tv3** (~$80, 8-port, VLAN + basic L2 ACLs, fanless, quiet). Alternative: **MikroTik CRS112-8G-4S** if you want SFP uplinks and more CLI control (~$150). Avoid PoE for this role — no cameras or APs in scope.

Rationale: machines need VLAN isolation from shop Wi-Fi and office LAN; a dumb switch can't enforce that. GS108Tv3 is unmanaged-simple to configure but supports 802.1Q.

## UPS

**CyberPower CP1500PFCLCD** (~$200, 1500VA/1000W, pure sine wave, USB for NUT/apcupsd shutdown signaling). Runtime for edge box (~40W) + 8-port switch (~10W) is 30–45 minutes — plenty. You want clean shutdown on blips, not long runtime.

Alternative: **APC BR1500MS2** is similar class. Avoid simulated-sine-wave units with active PFC power supplies (common in mini PCs) — they can fault.

## Shop-floor gotchas

- **Coolant mist is the killer**, not dust. Mount the cabinet away from machine enclosure doors and flood-coolant splash zones. Keep cabinet door gasketed.
- **Fanless preferred** where budget allows (Protectli, SuperMicro). Fans pull mist-laden air through the chassis and onto the board — expect 2–3 year lifespan on fanned mini-PCs in a shop vs. 7+ fanless.
- **Ambient tolerance**: consumer mini-PCs spec 0–35 °C. Shop cabinets can hit 35–40 °C in summer even in climate-controlled shops. Verify cabinet ventilation or add a filtered 120 mm fan with a cleanable foam filter.
- **Mounting**: VESA mount or DIN-rail adapter inside the cabinet. Don't sit the box on the cabinet floor (vibration, coolant pooling).
- **Tamper**: Kensington lock on the PC, keyed cabinet, TPM-bound LUKS so a stolen drive is useless. Log cabinet opens if you get serious about CMMC evidence.
- **Verify before buying**: Dell / Lenovo SKUs rotate quarterly, and Protectli occasionally revises NIC chipsets — confirm current model specs with the vendor before ordering.
