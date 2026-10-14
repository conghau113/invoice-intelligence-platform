# GENERATED from packages/contracts - DO NOT EDIT. Run: pnpm --filter contracts generate:python

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, Field, confloat, conint, constr


class Seller(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    name: constr(min_length=1, strict=True)
    taxCode: constr(pattern=r"^\d{10}(-\d{3})?$", strict=True)
    address: constr(min_length=1, strict=True)


class Buyer(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    name: constr(min_length=1, strict=True)
    taxCode: constr(pattern=r"^\d{10}(-\d{3})?$", strict=True)
    address: constr(min_length=1, strict=True)


class Line(BaseModel):
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


class InvoiceDraft(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    seller: Seller
    buyer: Buyer
    invoiceNo: constr(min_length=1, strict=True)
    series: constr(min_length=1, strict=True)
    issueDate: date
    currency: constr(pattern=r"^[A-Z]{3}$", strict=True)
    lines: list[Line] = Field(..., min_length=1)
    subtotal: conint(ge=-9007199254740991, le=9007199254740991, strict=True)
    vatBreakdown: list[VatBreakdownItem]
    total: conint(ge=-9007199254740991, le=9007199254740991, strict=True)
