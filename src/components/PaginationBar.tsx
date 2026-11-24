import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Language } from '../lib/i18n';

export const DEFAULT_PAGE_SIZE = 40;

interface PaginationBarProps {
  lang: Language;
  page: number;
  pageSize?: number;
  totalItems: number;
  onPageChange: (nextPage: number) => void;
}

export const PaginationBar: React.FC<PaginationBarProps> = ({
  lang,
  page,
  pageSize = DEFAULT_PAGE_SIZE,
  totalItems,
  onPageChange,
}) => {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (totalItems <= pageSize) return null;

  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIdx = (safePage - 1) * pageSize + 1;
  const endIdx = Math.min(totalItems, safePage * pageSize);

  return (
    <div className="px-4 py-3 border-t border-stone-200 bg-stone-50/70 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 no-print">
      <span className="font-mono tabular-nums">
        {lang === 'bn'
          ? `মোট ${totalItems} জনের মধ্যে ${startIdx}–${endIdx}`
          : `Showing ${startIdx}–${endIdx} of ${totalItems}`}
      </span>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-white border border-stone-300 rounded-md hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          <span>{lang === 'bn' ? 'পূর্ববর্তী' : 'Prev'}</span>
        </button>

        <span className="px-2.5 py-1 font-mono tabular-nums font-medium text-slate-800">
          {safePage} / {totalPages}
        </span>

        <button
          type="button"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(safePage + 1)}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-white border border-stone-300 rounded-md hover:bg-stone-100 disabled:opacity-40 cursor-pointer"
        >
          <span>{lang === 'bn' ? 'পরবর্তী' : 'Next'}</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
