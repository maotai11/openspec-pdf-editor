const DEFAULT_SIGNATURE_WIDTH = 520;
const DEFAULT_SIGNATURE_HEIGHT = 180;

function escapeSvgText(value) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '') // 移除控制字符
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildTypedSignatureSvgMarkup({
  signerName = '',
  subtitle = '電子簽署',
  dateText = '',
  includeDate = true,
  color = '#1F2937',
  accentColor = '#2563EB',
  width = DEFAULT_SIGNATURE_WIDTH,
  height = DEFAULT_SIGNATURE_HEIGHT,
} = {}) {
  const normalizedName = String(signerName ?? '').trim() || '簽署者';
  const normalizedSubtitle = String(subtitle ?? '').trim();
  const normalizedDate = includeDate ? String(dateText ?? '').trim() : '';
  const lineY = Math.round(height * 0.66);
  const nameY = Math.round(height * 0.48);
  const subtitleY = Math.round(height * 0.2);
  const dateY = Math.round(height * 0.86);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="transparent"/>',
    normalizedSubtitle
      ? `<text x="0" y="${subtitleY}" fill="${accentColor}" font-size="24" font-family="Microsoft JhengHei, PingFang TC, sans-serif" font-weight="600">${escapeSvgText(normalizedSubtitle)}</text>`
      : '',
    `<text x="0" y="${nameY}" fill="${color}" font-size="58" font-family="'Segoe Script', 'Microsoft JhengHei', cursive" font-weight="700" xml:space="preserve">${escapeSvgText(normalizedName)}</text>`,
    `<line x1="0" y1="${lineY}" x2="${Math.round(width * 0.92)}" y2="${lineY}" stroke="${accentColor}" stroke-width="3" stroke-linecap="round"/>`,
    normalizedDate
      ? `<text x="0" y="${dateY}" fill="${color}" font-size="20" font-family="Microsoft JhengHei, PingFang TC, sans-serif">${escapeSvgText(normalizedDate)}</text>`
      : '',
    '</svg>',
  ].join('');
}

export function svgMarkupToDataUrl(svgMarkup) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
}

export function buildTypedSignaturePreset({
  signerName = '',
  subtitle = '電子簽署',
  dateText = '',
  includeDate = true,
  color = '#1F2937',
} = {}) {
  const svgMarkup = buildTypedSignatureSvgMarkup({
    signerName,
    subtitle,
    dateText,
    includeDate,
    color,
  });

  return {
    mode: 'typed',
    signerName: String(signerName ?? '').trim(),
    subtitle: String(subtitle ?? '').trim(),
    dateText: includeDate ? String(dateText ?? '').trim() : '',
    includeDate: Boolean(includeDate),
    color,
    dataUrl: svgMarkupToDataUrl(svgMarkup),
  };
}

export function buildSignatureAnnotationContent(signaturePreset = {}) {
  const signerName = String(signaturePreset.signerName ?? '').trim();
  const dateText = signaturePreset.includeDate ? String(signaturePreset.dateText ?? '').trim() : '';
  return [signerName, dateText].filter(Boolean).join('\n') || '電子簽署';
}

