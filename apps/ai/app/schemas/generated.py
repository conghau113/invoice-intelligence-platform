# GENERATED from packages/contracts - DO NOT EDIT. Run: pnpm --filter contracts generate:python

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, confloat, conint, constr


class Party(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    name: constr(min_length=1, strict=True)
    taxCode: constr(pattern=r"^[0-9]{10}(-[0-9]{3})?$", strict=True)
    address: constr(min_length=1, strict=True)


class Buyer(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    name: constr(min_length=1, strict=True)
    taxCode: constr(pattern=r"^[0-9]{10}(-[0-9]{3})?$", strict=True) | None
    address: constr(min_length=1, strict=True)


class InvoiceLine(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    description: constr(min_length=1, strict=True)
    quantity: confloat(gt=0.0, strict=True)
    unit: constr(min_length=1, strict=True)
    unitPrice: conint(ge=-9007199254740991, le=9007199254740991, strict=True)
    vatRate: confloat(ge=0.0, le=100.0, strict=True)
    amount: conint(ge=-9007199254740991, le=9007199254740991, strict=True)


class VatBreakdownItem(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    rate: confloat(ge=0.0, le=100.0, strict=True)
    base: conint(ge=-9007199254740991, le=9007199254740991, strict=True)
    amount: conint(ge=-9007199254740991, le=9007199254740991, strict=True)


class Evidence(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    page: conint(ge=1, le=9007199254740991, strict=True)
    text: constr(min_length=1, max_length=500, strict=True)


class FieldMeta(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    confidence: confloat(ge=0.0, le=1.0, strict=True)
    evidence: Evidence | None


class Invoice(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    seller: Party
    buyer: Buyer
    invoiceNo: constr(min_length=1, strict=True)
    series: constr(min_length=1, strict=True)
    issueDate: constr(
        pattern=r"^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))$",
        strict=True,
    )
    currency: constr(pattern=r"^[A-Z]{3}$", strict=True)
    lines: list[InvoiceLine] = Field(..., min_length=1)
    subtotal: conint(ge=-9007199254740991, le=9007199254740991, strict=True)
    vatBreakdown: list[VatBreakdownItem]
    total: conint(ge=-9007199254740991, le=9007199254740991, strict=True)
    fieldMeta: dict[
        constr(
            pattern=r"^(?:(?:seller|buyer)\.(?:name|taxCode|address)|invoiceNo|series|issueDate|currency|subtotal|total|lines\.(?:0|[1-9][0-9]*)\.(?:description|quantity|unit|unitPrice|vatRate|amount)|vatBreakdown\.(?:0|[1-9][0-9]*)\.(?:rate|base|amount))$",
            strict=True,
        ),
        FieldMeta,
    ]
