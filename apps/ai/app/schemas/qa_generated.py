# GENERATED from packages/contracts - DO NOT EDIT. Run: pnpm --filter contracts generate:python

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, constr


class Intent(StrEnum):
    lookup = "lookup"
    aggregate = "aggregate"
    out_of_scope = "out_of_scope"


class Metric(StrEnum):
    total = "total"
    subtotal = "subtotal"
    vatAmount = "vatAmount"
    lineAmount = "lineAmount"
    invoiceCount = "invoiceCount"


class QaAggregateFilter(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    metric: Metric
    sellerName: constr(min_length=1, max_length=200, strict=True) | None
    sellerTaxCode: constr(pattern=r"^[0-9]{10}(-[0-9]{3})?$", strict=True) | None
    issueDateFrom: (
        constr(
            pattern=r"^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))$",
            strict=True,
        )
        | None
    )
    issueDateTo: (
        constr(
            pattern=r"^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))$",
            strict=True,
        )
        | None
    )
    currency: constr(pattern=r"^[A-Z]{3}$", strict=True) | None
    itemDescription: constr(min_length=1, max_length=200, strict=True) | None


class QaAnswer(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    insufficientEvidence: bool
    answer: constr(max_length=4000, strict=True)


class QaRoute(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    intent: Intent
    filter: QaAggregateFilter | None


class QaModelOutputs(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    route: QaRoute
    answer: QaAnswer
