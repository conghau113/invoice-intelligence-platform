import type { DocumentStatus } from '@/components/common/status-badge';

// Synthetic only: SAMPLE names and tax codes with an invalid check digit. Money is integer minor units.
export type SampleInvoice = {
  id: string;
  number: string;
  seller: string;
  issuedAt: string;
  totalVnd: number;
  status: DocumentStatus;
};

export const SAMPLE_INVOICES: SampleInvoice[] = [
  {
    id: '1',
    number: 'SAMPLE-0001',
    seller: 'SAMPLE Công ty A',
    issuedAt: '2026-03-15T00:00:00+07:00',
    totalVnd: 1100000,
    status: 'approved',
  },
  {
    id: '2',
    number: 'SAMPLE-0002',
    seller: 'SAMPLE Công ty B',
    issuedAt: '2026-03-16T00:00:00+07:00',
    totalVnd: 24850000,
    status: 'needs_review',
  },
  {
    id: '3',
    number: 'SAMPLE-0003',
    seller: 'SAMPLE Công ty C',
    issuedAt: '2026-03-18T00:00:00+07:00',
    totalVnd: 530000,
    status: 'processing',
  },
  {
    id: '4',
    number: 'SAMPLE-0004',
    seller: 'SAMPLE Công ty D',
    issuedAt: '2026-03-20T00:00:00+07:00',
    totalVnd: 7200000,
    status: 'failed',
  },
];

export const SAMPLE_TAX_CODE = '0312345678'; // check digit is wrong on purpose
