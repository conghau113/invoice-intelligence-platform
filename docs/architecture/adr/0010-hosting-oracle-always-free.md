# ADR 0010: Hosting: local development, public demo on Oracle Cloud Always Free (ARM)

- Status: Accepted — owner approved card verification on 2026-10-12
- Date: 2026-10-11

## Context
Constraint: zero monetary cost. The demo needs Keycloak (~0.75–1 GB RAM), Postgres, Redis, three app processes (~2.5–3 GB total). Options checked on 2026-10-11/12: Azure free account = $200 for 30 days + 12 months of 1 GB burstable VMs (insufficient, card required, risk of charges after 12 months); Azure for Students requires full-time student status (owner not eligible); Hetzner ~€4.5/month (paid); Oracle Always Free A1 = 2 OCPU / 12 GB ARM for the life of the account (cut from 4/24 on 2026-06-15 without announcement), card verification at sign-up, capacity not guaranteed, idle instances may be reclaimed.

## Options considered
1. Local only + video
2. Oracle Always Free A1 + DuckDNS + Caddy
3. Hetzner VPS (paid)
4. Azure free account
5. Kubernetes on any of the above

## Decision criteria
- Monetary cost (must be 0)
- Fits memory budget
- Operational learning
- Resilience to provider changes

## Decision
Develop locally (WSL2 + Docker). From M4, run a read-only public demo on one Oracle Always Free A1 VM (Ubuntu, Docker Compose, Caddy with Let's Encrypt, DuckDNS subdomain, images built for linux/arm64). Never upgrade the account to Pay-As-You-Go without the owner's approval. Keep infrastructure as code, daily encrypted backups outside Oracle, and a rebuild runbook. If no capacity or the VM is lost, rebuild or fall back to a recorded video demo.

## Consequences
- + €0 with ~4× the memory the stack needs
- + Realistic ops skills (TLS, firewall, backups, multi-arch images)
- − Capacity and terms are not guaranteed; single VM, no autoscaling
- − ARM requires multi-arch images

## Revisit when
Oracle changes Always Free terms, reclaims the VM repeatedly, or the owner approves a paid option.
