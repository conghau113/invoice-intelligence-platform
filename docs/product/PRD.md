# Product Requirements

## 1. Problem
Accountants at small and mid-size companies receive supplier invoices as e-invoice XML files, PDFs and phone photos. They re-type the data, check totals by hand, and later dig through folders to answer simple questions. It is slow and error-prone, and every company's data must stay separate when the tool is offered as SaaS.

## 2. Personas
| Persona | Goal | Pain today |
|---|---|---|
| **Linh — accountant** (primary) | Capture 100–300 invoices/month correctly | Manual typing, missed arithmetic errors |
| **Minh — finance lead / tenant admin** | Control who can approve, see spend by supplier | No overview, answers take hours |
| **Viewer — auditor/manager** | Read-only access, ask questions | Must ask the accountant for everything |

## 3. Scope

**In scope (v1):** multi-tenant workspaces, login (OIDC), roles, upload (XML/PDF/image), automatic extraction, human review and approval, Q&A over approved invoices with citations, realtime progress, Vietnamese and English UI, extraction quality metrics.

**Out of scope:** issuing invoices, submitting to tax authorities, accounting ledgers, payments, mobile apps, real customer data, public uploads in the demo.

## 4. Screens
| Route | Purpose | Roles |
|---|---|---|
| `/[locale]/login` | Sign in via Keycloak | all |
| `/[locale]/documents` | List with status filters, search, pagination | all |
| `/[locale]/upload` | Drag-and-drop multi-file upload with progress | admin, accountant |
| `/[locale]/documents/[id]` | Review: document viewer + form, warnings, approve | all (approve: admin, accountant) |
| `/[locale]/ask` | Q&A chat with citations | all |
| `/[locale]/insights` | Extraction accuracy, correction rate, cost per document | all |
| `/[locale]/settings/members` | Members and roles of the tenant | admin |
| Header | Language switcher, tenant switcher, notifications | all |

## 5. Business rules
1. Line amounts sum to the subtotal; subtotal + VAT = total (±1 minor-unit rounding tolerance).
2. Vietnamese tax code: 10 digits, or 10 digits + `-` + 3 digits for branches.
3. Issue date cannot be in the future; currency must be in the allowed list (VND, USD, EUR, JPY at v1).
4. Rule violations are **warnings** shown on the field; the system never silently changes numbers.
5. Only approved invoices are searchable in Q&A.
6. A document's content hash is unique per tenant; re-uploading returns the existing document.
7. Approval requires the latest version (concurrent approvals → second one fails).

## 6. Languages
- UI fully in Vietnamese and English; default from cookie → `Accept-Language` → Vietnamese.
- Numbers, dates and money formatted by locale (`Intl`).
- Q&A answers in the language of the question.
- Extraction handles Vietnamese and English documents.

## 7. User stories (acceptance summarized; details live in task "done when" lists)
| ID | Story | Milestone |
|---|---|---|
| US-01 | As a user I sign in with my company account and only see my company's data | M1 |
| US-02 | As a user I switch the UI between Vietnamese and English | M1 |
| US-03 | As an accountant I upload many files at once and see progress | M2 |
| US-04 | As an accountant I see extracted fields with low-confidence fields highlighted | M3 |
| US-05 | As an accountant I correct and approve an invoice | M3 |
| US-06 | As a finance lead I see how accurate the extraction is and what it costs | M4 |
| US-07 | As a user I ask questions and get answers with links to the source invoices | M5 |
| US-08 | As a user I get notified when processing finishes without refreshing | M6 |
| US-09 | As an admin I retry failed documents and see why they failed | M6 |
| US-10 | As a visitor I try a read-only demo account (browse processed sample invoices, review screens, metrics, and sample questions with precomputed cited answers) | M4/M7 |

## 8. Success measures
See `NFR.md` for system targets. Product-level: median time from upload to approval for a clean invoice under 1 minute in the demo; human correction rate per field tracked on `/insights`.
