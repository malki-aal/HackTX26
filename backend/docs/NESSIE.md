# Nessie: verified behavior notes

Status: **verified live on 2026-10-24** against `https://prod-api.nessieisreal.com` with the team's key. Runway used only customer (non-enterprise) endpoints and resources it created.

## Origin and auth

- The docs site, https://prod.nessieisreal.com/docs, is rendered client-side. It loads the spec from https://prod.nessieisreal.com/nessie-openapi-spec.yaml (OpenAPI 3.0.3).
- The API origin is `https://prod-api.nessieisreal.com`, taken from the spec's `servers` list and confirmed live. The getting-started page's `api.nessieisreal.com` example is historical.
- Auth uses the `key` query parameter. Runway redacts `key=` from every logged or stored URL; a scan of the database, recordings and logs found no key values.

## Routes observed live

| Route | Status | Notes |
|---|---|---|
| `GET /customers` | 200 | Bare JSON array; empty for a new key |
| `POST /customers` | 201 | `{code, message, objectCreated}` |
| `GET /customers/{id}/accounts` | 200 | Bare array |
| `POST /customers/{id}/accounts` | 201 | `{code, message, objectCreated}` |
| `GET /accounts/{id}` | 200 | Bare object; `balance` is a number in whole dollars (`25000`) |
| `POST /accounts/{id}/bills` | 201 | **Accepted without `payment_date`, but every later bill list on the account then failed** (below) |
| `GET /accounts/{id}/bills` | 200 / 400 | 400 `"1 validation error for Bill\npayment_date field required"` while a bill lacked `payment_date` |
| `PUT /bills/{id}` | 202 | `{code:202, message:"Accepted bill update", objectUpdated}`; used to add the missing `payment_date` |
| `GET /accounts/{id}/purchases` | 200 | **Missing from the published spec, but it works**; bare array |
| `POST /accounts/{id}/purchases` | 201 | **Missing from the published spec, but it works** (see below) |
| `GET /purchase/{id}` | 200 | Bare object |
| `GET /merchants` | 200 | Empty for this key |
| `POST /merchants` | 201 / 400 | `category` must be a **string**; an array is rejected with 400 |

Ids are UUIDs, for example `56b93197-ef98-45cf-8f88-6aee8d0e7cd9`. The spec's 24-character ids are not what this deployment returns.

## Purchase record (live)

Runway sent `{merchant_id, medium:"balance", purchase_date, amount: 587.56, status:"pending", description}`. Nessie stored:

```json
{"_id":"56b93197-…","type":"merchant","merchant_id":"9e94b545-…","payer_id":"0b861bad-…","purchase_date":"2026-10-25",
 "amount":587,"status":"pending","medium":"balance","description":"Runway exe_e35ac862231a4804 | Crua 27 inch 4K UHD Monitor … x4 | seller Walmart - CRUA Technology"}
```

- **Amounts are whole dollars.** `587.56` was silently stored as `587`. Runway keeps the approved $587.56 as its budget figure (the conservative choice) and records the stored $587.00 as `providerAmountCents`, with the difference shown as `amountDiscrepancyCents` (56). Balance reconciliation matches against the stored amount.
- The date field is `purchase_date`. The docs page shows `transaction_date`; the adapter reads both.
- Status was `pending` immediately after creation and on read-back.

## Balance semantics (live)

The reported balance was **unchanged** after creating a pending purchase: $25,000 before and after. Runway therefore keeps the purchase in its local ledger as an unreflected expense:

```
balance 25,000.00 - pending bill 1,500.00 - unreflected expense 587.56 = available 22,912.44
```

If Nessie later posts the purchase and the balance drops by exactly the stored amount, the expense is marked reflected and is no longer subtracted. Any other change keeps it subtracted and adds a note. Tests cover the balance changing, staying unchanged, and the whole-dollar case.

## Seeding

`npm run seed:nessie` creates or reuses the fictional customer "Runway Demo Co (fictional)", the checking account "Runway Demo Operating (sandbox)" with $25,000, and one pending bill ("Fictional Office Lease LLC", $1,500, now sent with `payment_date`). Ids are stored in `var/runway.sqlite`. A rerun reused all three with no new POSTs.

## Retry limitations

- Reads retry up to two times with backoff.
- The purchase POST is sent once. A timeout or 5xx response makes the execution `uncertain`, keeps the budget hold, and is resolved through `reconcile`, which matches the purchase by the `Runway exe_…` reference in `description`. It is never resent automatically.
