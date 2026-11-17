/**
 * Shared HTML shell for all SocketMonnie transactional emails — the single
 * source of the 2026 transactional design language used by every template.
 *
 * Design goals (GitHub / LinkedIn-grade official transactional mail):
 *   - table-based layout with a 480px card, 1px border, neutral slate palette
 *   - hidden preheader text for the inbox preview line
 *   - a plain-language reason line (CAN-SPAM / Gmail / Outlook heuristics)
 *   - a real support contact and a brand tagline
 *   - no spam-trigger copy, no fabricated details
 *
 * Call signature: wrapEmail({ heading, bodyHtml, preheader?, tag?, reason? })
 *   heading  — <h1> inside the card
 *   bodyHtml — template-specific body markup (inserted raw)
 *   preheader— hidden preview text (inbox preview line)
 *   tag      — right-side eyebrow label on the brand bar
 *   reason   — "You're receiving this email because…" line in the footer
 */
const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function wrapEmail({
  heading,
  bodyHtml,
  preheader = "A message from SocketMonnie — your cooperative savings platform",
  tag = "SocketMonnie",
  reason = "you have an account with SocketMonnie",
}) {
  const safeHeading = escapeHtml(heading);
  const safePreheader = escapeHtml(preheader);
  const safeTag = escapeHtml(tag);
  const safeReason = escapeHtml(reason);

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta http-equiv="x-ua-compatible" content="ie=edge" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<title>SocketMonnie — ${safeHeading}</title>
<!--[if mso]><style type="text/css">body,table,td{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">

<!-- Preheader / preview text -->
<div style="display:none;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">
  ${safePreheader}
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;">
  <tr>
    <td align="center" style="padding:40px 16px 24px;">

      <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">

        <!-- Brand bar -->
        <tr>
          <td style="padding:26px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font:700 20px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#090f24;letter-spacing:-0.02em;">
                  SocketMonnie
                </td>
                <td align="right" style="font:600 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#64748b;letter-spacing:0.08em;text-transform:uppercase;">
                  ${safeTag}
                </td>
              </tr>
            </table>
            <div style="height:1px;background:#e2e8f0;margin-top:20px;font-size:0;line-height:0;">&nbsp;</div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:26px 32px 8px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#334155;">
            <h1 style="margin:0 0 16px 0;font-size:21px;line-height:1.35;font-weight:700;color:#0f172a;letter-spacing:-0.01em;">
              ${safeHeading}
            </h1>
            ${bodyHtml}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px 26px 32px;">
            <div style="height:1px;background:#e2e8f0;margin-bottom:18px;font-size:0;line-height:0;">&nbsp;</div>
            <p style="margin:0 0 6px 0;font-size:12px;line-height:1.65;font-weight:600;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              SocketMonnie — helping members save, borrow and grow together
            </p>
            <p style="margin:0 0 4px 0;font-size:11px;line-height:1.65;color:#64748b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              You're receiving this email because ${safeReason}.
            </p>
            <p style="margin:0;font-size:11px;line-height:1.65;color:#64748b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              Questions? <a href="mailto:support@socketmoni.com" style="color:#3b62ec;text-decoration:none;">support@socketmoni.com</a>
            </p>
          </td>
        </tr>

      </table>

      <p style="max-width:480px;margin:18px auto 0;text-align:center;font-size:10px;line-height:1.6;color:#94a3b8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        © ${new Date().getFullYear()} SocketMonnie. Secure cooperative platform.
      </p>

    </td>
  </tr>
</table>

</body>
</html>
`;
}

// Shared body snippets.
const codeBlock = (code) => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px auto;">
              <tr>
                <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 32px 14px 44px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:12px;color:#0f172a;text-align:center;">
                  ${escapeHtml(code)}
                </td>
              </tr>
            </table>
`;

const securityNote = () => `
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.6;color:#475569;">
              Never share this code with anyone, including SocketMonnie staff. We will never ask for your password, transaction PIN or verification code.
            </div>
`;

const securityLine = () => `
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.6;color:#475569;margin-top:18px;">
              SocketMonnie will never ask for your password, transaction PIN or verification code. Anyone who does is not SocketMonnie.
            </div>
`;

const ctaButton = (href, label) => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px auto;">
              <tr>
                <td style="background:#090f24;border-radius:8px;">
                  <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:0.01em;">
                    ${escapeHtml(label)}
                  </a>
                </td>
              </tr>
            </table>
`;

const detailTable = (rows) => `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
              ${rows
                .map(
                  ([label, value], index) => `
              <tr>
                <td style="padding:12px 16px;background:#f8fafc;width:40%;font-size:12px;color:#64748b;border-bottom:${index === rows.length - 1 ? "none" : "1px solid #e2e8f0"};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                  ${escapeHtml(label)}
                </td>
                <td style="padding:12px 16px;font-size:13px;color:#0f172a;font-weight:600;border-bottom:${index === rows.length - 1 ? "none" : "1px solid #e2e8f0"};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                  ${escapeHtml(value)}
                </td>
              </tr>`
                )
                .join("")}
            </table>
`;

module.exports = { wrapEmail, codeBlock, securityNote, securityLine, ctaButton, detailTable, escapeHtml };
