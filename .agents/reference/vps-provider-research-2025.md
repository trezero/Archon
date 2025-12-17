# VPS Provider Research for Self-Hosting (December 2025)

This document provides comprehensive research on VPS providers for self-hosting backend applications (like this remote coding agent) and running Claude Code CLI remotely.

---

## Executive Summary

### Top Recommendations by Use Case

| Use Case | Provider | Monthly Cost | Why |
|----------|----------|--------------|-----|
| **Best Overall Value** | Hetzner CX22 | ~$4.15 (EUR 3.79) | 4GB RAM, 2 vCPU, 20TB transfer |
| **Best Free Tier** | Oracle Cloud ARM | $0 | 4 OCPU, 24GB RAM (with caveats) |
| **Best US-Based** | Linode Shared 4GB | $20 | Best bandwidth overage pricing |
| **Best Ultra-Budget** | RackNerd (deals) | ~$1.50 | $18/year for 2GB RAM |
| **Best for Beginners** | DigitalOcean | $12 | $200 free credit, great docs |
| **Best PaaS Experience** | Render | $7 | 750 free hours/month |

### Quick Decision Guide

```
Need cheapest possible?
├── EU latency OK? → Hetzner CX22 ($4.15/mo)
├── Can catch deals? → RackNerd ($18/year)
└── Need free? → Oracle Cloud ARM (4 CPU, 24GB)

Need US-based hosting?
├── Budget priority? → Linode Shared 2GB ($10/mo)
├── Want managed? → DigitalOcean ($12/mo + $200 credit)
└── PaaS preferred? → Render ($7/mo)

Running Claude Code remotely?
├── Persistent sessions → Any VPS + tmux + SSH
├── Automation/CI → Claude Agent SDK or GitHub Actions
└── Isolated containers → Docker + ClaudeBox
```

---

## Ranked Provider List

### Tier 1: Best Value (Recommended)

#### 1. Hetzner (Best Overall Value)

**Why #1:** 2-3x better specs than US competitors at the same price.

| Plan | vCPU | RAM | Storage | Transfer | Price |
|------|------|-----|---------|----------|-------|
| CX22 | 2 | 4GB | 40GB NVMe | 20TB | EUR 3.79/mo (~$4.15) |
| CX32 | 4 | 8GB | 80GB NVMe | 20TB | EUR 6.80/mo (~$7.40) |
| CAX21 (ARM) | 4 | 8GB | 80GB NVMe | 20TB | EUR 6.49/mo (~$7.10) |

**Block Storage:** EUR 0.044/GB/mo (~half the competition)

**Auction Servers:** Dedicated hardware at steep discounts (e.g., 256GB RAM server < EUR 39/mo)

**Locations:** Nuremberg, Falkenstein, Helsinki (EU); Ashburn, Hillsboro (US); Singapore

**Pros:**
- Unmatched price/performance ratio
- 20TB transfer included (vs 1-5TB elsewhere)
- Cheapest block storage
- AMD EPYC processors
- ARM options for even better value

**Cons:**
- Limited US/Asia presence (higher prices outside EU)
- Less polished interface than DigitalOcean
- Support can be slower

**Best For:** Production workloads, developers, anyone who can tolerate EU latency

---

#### 2. Oracle Cloud Always Free (Best Free Tier)

**Why #2:** Unmatched free resources - 4 OCPU, 24GB RAM, forever.

**Free Tier Includes:**
- Up to 4 ARM OCPUs + 24GB RAM (flexible allocation)
- 200GB block volume storage
- 10TB/month outbound transfer
- Reserved public IP

**Critical Caveats:**
- ARM instances frequently out of stock in popular regions
- Idle instances (<20% CPU over 7 days) may be reclaimed
- Account termination risks with virtual/prepaid cards
- No official support for free tier

**How to Succeed:**
1. Upgrade to Pay-As-You-Go (free resources remain free, no idle reclamation)
2. Use a real credit card (not Privacy.com/virtual)
3. Keep some CPU usage above 20%
4. Make regular backups

**Best For:** Hobbyists, testing, learning - with awareness of limitations

---

#### 3. Linode/Akamai (Best US-Based Traditional)

| Plan | vCPU | RAM | Storage | Transfer | Price |
|------|------|-----|---------|----------|-------|
| Shared 2GB | 1 | 2GB | 50GB | 2TB | $10/mo |
| Shared 4GB | 2 | 4GB | 80GB | 4TB | $20/mo |
| Shared 8GB | 4 | 8GB | 160GB | 5TB | $40/mo |

**Bandwidth Overage:** $0.005/GB (half of DigitalOcean!)

**Locations:** 25+ regions including Tokyo, Singapore, Mumbai, Sydney

**Pros:**
- Best bandwidth pricing
- Consistent pricing across regions
- Backed by Akamai infrastructure
- Many US data center options

**Cons:**
- Interface less polished than DigitalOcean
- No free tier

**Best For:** US-based production, high-bandwidth applications

---

### Tier 2: Budget Options

#### 4. RackNerd (Best Ultra-Budget)

**Deal Pricing (When Available):**
- 2GB RAM, 2 vCPU, 30GB SSD: ~$18/year (~$1.50/mo)
- Prices locked for life (no renewal increases)

**Regular Pricing:** ~$1.92/mo starting

**Locations:** 13 (US + Dublin, Amsterdam)

**Pros:**
- Insane deal pricing when available
- 99.993% uptime reported
- Free daily backups
- Price lock guarantee on deals

**Cons:**
- Must catch promotional periods
- Some reports of oversubscription

**Best For:** Budget-conscious hobbyists who can wait for deals

---

#### 5. Contabo (Best RAM/Dollar)

| Plan | vCPU | RAM | Storage | Price |
|------|------|-----|---------|-------|
| Cloud VPS S | 4 | 8GB | 50GB NVMe | ~$5.50/mo |
| Cloud VPS M | 6 | 12GB | 100GB NVMe | ~$8/mo |

**Price Per GB RAM:** ~$0.69/GB (best in industry)

**Locations:** 12 (US, EU, UK, Singapore, Japan, Australia)

**Pros:**
- Most RAM per dollar
- 12 global locations
- AMD EPYC processors

**Cons:**
- No SLA with financial compensation
- Support slow during outages
- Reports of overallocation
- Location fees for non-US DCs

**Best For:** Development, testing, non-critical workloads needing lots of RAM

---

#### 6. BuyVM (Best Reliability When Available)

| Plan | vCPU | RAM | Price |
|------|------|-----|-------|
| Slice 1024 | 1 | 1GB | ~$3.50/mo |
| Slice 2048 | 2 | 2GB | ~$3.50/mo |

**Block Storage:** 256GB for $1.25/mo, 1TB for $5/mo

**DDoS Protection:** $3/mo per IP (excellent)

**Locations:** Las Vegas, Piscataway (NJ), Luxembourg

**Critical Issue:** Frequently out of stock - monitor [buyvmstock.com](https://buyvmstock.com)

**Best For:** Users who can wait for stock, need DDoS protection

---

#### 7. Hostinger (Best Beginner UI)

| Plan | vCPU | RAM | Storage | Bandwidth | Promo | Renewal |
|------|------|-----|---------|-----------|-------|---------|
| KVM 1 | 1 | 4GB | 50GB NVMe | 4TB | $4.99/mo | $9.99/mo |
| KVM 2 | 2 | 8GB | 100GB NVMe | 8TB | $7.49/mo | $12.99/mo |
| KVM 4 | 4 | 16GB | 200GB NVMe | 16TB | $9.99/mo | $24.99/mo |
| KVM 8 | 8 | 32GB | 400GB NVMe | 32TB | $19.99/mo | $49.99/mo |

**Hardware:** AMD EPYC processors, 1 Gbps network

**Included Free:**
- Weekly backups + snapshot
- Firewall management
- AI assistant (Kodee)
- .cloud domain (1 year)

**Pros:**
- Beginner-friendly UI
- Good promotional pricing
- 30-day money-back guarantee
- Decent specs for the promo price

**Cons:**
- **Renewal prices nearly double** (e.g., KVM 4: $9.99 → $24.99)
- Less transfer than Hetzner (4TB vs 20TB)
- Promo requires longer commitment

**vs Hetzner:** Similar promo price, but Hetzner has no renewal increase and 5x more bandwidth.

**Best For:** Beginners who want managed experience and good UI, willing to pay more long-term

---

### Tier 3: Established Providers

#### 8. DigitalOcean (Best Documentation)

| Plan | vCPU | RAM | Storage | Price |
|------|------|-----|---------|-------|
| Basic | 1 | 1GB | 25GB SSD | $6/mo |
| Premium AMD | 1 | 2GB | 50GB NVMe | $12/mo |
| Premium Intel | 2 | 4GB | 80GB NVMe | $24/mo |

**Free Credits:** $200 for 60 days (new users)

**Pros:**
- Excellent documentation/tutorials
- Intuitive interface
- Strong developer community
- Managed database options

**Cons:**
- More expensive than Hetzner
- Premium tier required for NVMe

**Best For:** Beginners, those who value documentation and ease of use

---

#### 9. Vultr (Best Global Coverage)

| Plan | vCPU | RAM | Storage | Price |
|------|------|-----|---------|-------|
| High Frequency 2GB | 1 | 2GB | 64GB NVMe | $12/mo |
| High Frequency 4GB | 2 | 4GB | 128GB NVMe | $24/mo |

**Locations:** 32 regions (most in industry)

**Free Credits:** Up to $250 (promotional)

**Best For:** Global distribution, single-threaded performance

---

### Tier 4: European Alternatives

#### 10. Netcup (Germany)

- Famous EUR 1 VPS offers periodically
- AMD EPYC processors, excellent disk performance
- Nuremberg, Vienna, Amsterdam, Virginia locations

#### 11. UpCloud (Finland)

- $5/mo starting, zero-cost data transfer
- MaxIOPS storage (100k IOPS)
- **100% uptime SLA** with 50x payback

#### 12. Scaleway (France)

- ARM instances for energy efficiency
- Pay-as-you-go, free egress
- Paris, Amsterdam, Warsaw locations

#### 13. Time4VPS (Lithuania)

- EUR 1.99/mo for 2GB RAM
- 99.98% uptime guarantee
- HDD by default (SSD extra)

---

### Tier 5: PaaS/Managed Options

#### 14. Render (Best PaaS Free Tier)

- **Free:** 750 instance hours/month
- Starter: $7/mo per service
- Easy GitHub integration
- Managed databases included
- Services spin down after 15min inactivity (free tier)

#### 15. Railway (Best Developer Experience)

- $5/mo includes $5 usage
- Pay only for actual utilization
- Zero-config deployments
- Built-in PostgreSQL, Redis

#### 16. Fly.io (Best for Edge)

- $1.94/mo starting (256MB)
- Global edge network (35+ regions)
- Per-second billing
- Great for globally distributed apps

---

## Running Claude Code Remotely

### Recommended Setup

The most reliable approach combines SSH, tmux, and optionally Tailscale:

```
┌─────────────────┐     SSH/Tailscale     ┌─────────────────┐
│  Local Machine  │ ──────────────────────▶│   VPS Server    │
│  (any device)   │                        │  (tmux + Claude)│
└─────────────────┘                        └─────────────────┘
```

### System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| RAM | 4GB | 8GB+ |
| CPU | 2 cores | 4+ cores |
| Storage | 10GB | 20GB+ |
| OS | Ubuntu 20.04+ | Ubuntu 22.04/24.04 |

**Note:** No GPU needed - all inference happens on Anthropic's servers.

### Setup Options

#### Option 1: SSH + tmux (Simplest)

```bash
# On VPS: Install dependencies
curl -fsSL https://claude.ai/install.sh | bash

# Create persistent session
tmux new -s claude

# Run Claude Code
claude

# Detach: Ctrl+B, then D
# Reconnect later: tmux attach -t claude
```

#### Option 2: Tailscale + SSH (Most Secure)

```bash
# Install Tailscale on both machines
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Connect via private network
ssh user@<tailscale-ip>
tmux attach -t claude
```

#### Option 3: Docker (Most Isolated)

```bash
# Using ClaudeBox (recommended)
git clone https://github.com/RchGrav/claudebox
cd claudebox
./claudebox.sh

# Or simple container
docker run -it \
  -v ~/.config/claude-code/auth.json:/root/.config/claude-code/auth.json:ro \
  -v /path/to/workspace:/workspace \
  node:20 bash -c "npm install -g @anthropic-ai/claude-code && claude"
```

#### Option 4: Claude Agent SDK (Programmatic)

```typescript
// TypeScript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

### Mobile Access

For phone/tablet access:
1. Termius or Blink Shell (SSH client)
2. Tailscale for secure connection
3. Mosh for network resilience
4. tmux for session persistence

---

## Cost Comparison: 1 Year of Hosting

### Backend + PostgreSQL Setup

| Provider | Plan | Monthly | Storage (50GB) | Annual Total |
|----------|------|---------|----------------|--------------|
| **Hetzner** | CX22 (4GB) | $4.15 | $2.40 | **$79** |
| **RackNerd** | Deal (2GB) | $1.50 | Included | **$18** |
| **Oracle** | Free ARM (24GB) | $0 | Included | **$0** |
| **Contabo** | VPS S (8GB) | $5.50 | Included | **$66** |
| **Linode** | Shared 2GB | $10 | $5 | **$180** |
| **DigitalOcean** | Premium 2GB | $12 | $5 | **$204** |
| **Render** | Starter | $7 | $7 | **$168** |

### Running This Remote Coding Agent

Minimum requirements: 2GB RAM, 2 vCPU, PostgreSQL

| Provider | Plan | Cost | Notes |
|----------|------|------|-------|
| **Oracle Free** | ARM 4/24GB | $0/mo | Best value if available |
| **Hetzner** | CX22 | $4.15/mo | Reliable, great value |
| **RackNerd** | Deal | $1.50/mo | When deals available |
| **Render** | Starter | $7/mo | Managed, easy setup |

---

## Recommendations by Scenario

### Scenario 1: Hobbyist/Learning

**Recommended:** Oracle Cloud Free → Hetzner CX22

Start with Oracle's free tier. If you hit availability issues or get tired of the caveats, migrate to Hetzner for ~$4/month.

### Scenario 2: Production Backend (EU OK)

**Recommended:** Hetzner CX32 ($7.40/mo)

4 vCPU, 8GB RAM, 80GB NVMe, 20TB transfer. Unbeatable value for production workloads.

### Scenario 3: Production Backend (US Required)

**Recommended:** Linode Shared 4GB ($20/mo)

Best bandwidth pricing, reliable infrastructure, many US locations.

### Scenario 4: Global Distribution

**Recommended:** Fly.io or Vultr

- Fly.io: Edge deployment, auto-scaling
- Vultr: 32 data centers, consistent pricing

### Scenario 5: Maximum Ease of Use

**Recommended:** DigitalOcean or Render

- DigitalOcean: $200 free credit, excellent docs
- Render: 750 free hours, zero-config deployments

### Scenario 6: Remote Claude Code Development

**Recommended Setup:**
1. Hetzner CX22 or CX32 (~$4-7/mo)
2. Tailscale for secure access
3. tmux for persistent sessions
4. VS Code Remote SSH extension (optional)

---

## Provider Quick Reference

### By Price (Cheapest First)

1. Oracle Cloud Free: $0 (24GB RAM - with caveats)
2. RackNerd Deals: ~$1.50/mo (2GB RAM)
3. Hetzner CX22: $4.15/mo (4GB RAM)
4. Contabo VPS S: $5.50/mo (8GB RAM)
5. Render Starter: $7/mo (managed)
6. Linode Shared 2GB: $10/mo
7. DigitalOcean Premium: $12/mo (2GB)
8. Linode Shared 4GB: $20/mo

### By RAM/Dollar Value

1. Oracle Cloud Free: Infinite (24GB free)
2. Contabo: $0.69/GB
3. Hetzner: $1.04/GB
4. RackNerd: ~$0.75/GB on deals
5. Linode: $5/GB
6. DigitalOcean: $6/GB

### By Reliability

1. UpCloud: 100% SLA with 50x payback
2. Hetzner: Strong track record
3. Linode/Akamai: Enterprise backing
4. DigitalOcean: Well-established
5. Oracle Free: Variable (reclamation risk)
6. Contabo: Mixed reviews

### By Ease of Use

1. Render: Zero-config, PaaS
2. Railway: Great DX, GitHub integration
3. DigitalOcean: Excellent docs
4. Fly.io: CLI-driven, intuitive
5. Linode: Straightforward
6. Hetzner: Manual setup required

---

## Sources and Further Reading

### Provider Documentation
- [Hetzner Cloud](https://www.hetzner.com/cloud)
- [Linode Pricing](https://www.linode.com/pricing/)
- [DigitalOcean Droplets](https://www.digitalocean.com/pricing/droplets)
- [Oracle Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm)
- [Render Pricing](https://render.com/pricing)

### Claude Code Remote Setup
- [Claude Code Docker Guide](https://docs.docker.com/ai/sandboxes/claude-code/)
- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Claude Code GitHub Actions](https://github.com/anthropics/claude-code-action)
- [ClaudeBox (Docker)](https://github.com/RchGrav/claudebox)

### Community Discussions
- [LowEndTalk VPS Discussions](https://lowendtalk.com/)
- [r/selfhosted](https://reddit.com/r/selfhosted)
- [r/ClaudeAI](https://reddit.com/r/ClaudeAI)

---

*Last Updated: December 2025*
