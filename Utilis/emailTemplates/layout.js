/**
 * Shared HTML shell for all SocketMonnie transactional emails.
 * Keeps every template visually consistent without duplicating the same
 * CSS block in each file. Call signature: wrapEmail({ heading, bodyHtml }).
 */
function wrapEmail({ heading, bodyHtml }) {
  return `
<!DOCTYPE html>
<html>
<head>
<style>
body{
    margin:0;
    padding:0;
    background:#F3F7FC;
    font-family:Arial,Helvetica,sans-serif;
}

.container{
    max-width:600px;
    margin:40px auto;
    background:#ffffff;
    border-radius:12px;
    overflow:hidden;
    box-shadow:0 8px 30px rgba(0,0,0,.08);
}

.header{
    background:#2563EB;
    color:#fff;
    text-align:center;
    padding:35px 20px;
}

.logo{
    font-size:30px;
    font-weight:bold;
    letter-spacing:1px;
}

.body{
    padding:40px 35px;
    color:#374151;
    line-height:1.7;
}

.greeting{
    font-size:24px;
    color:#111827;
    margin-bottom:10px;
}

table.receipt-table{
    width:100%;
    border-collapse:collapse;
    margin:20px 0;
}
table.receipt-table td{
    padding:10px 8px;
    border-bottom:1px solid #E5E7EB;
    font-size:14px;
}

.amount-box{
    width:220px;
    margin:30px auto;
    background:#EFF6FF;
    border:2px dashed #2563EB;
    border-radius:12px;
    text-align:center;
    padding:18px;
}

.amount{
    font-size:32px;
    font-weight:bold;
    color:#2563EB;
}

.otp-box{
    width:220px;
    margin:30px auto;
    background:#EFF6FF;
    border:2px dashed #2563EB;
    border-radius:12px;
    text-align:center;
    padding:18px;
}

.otp{
    font-size:40px;
    font-weight:bold;
    color:#2563EB;
    letter-spacing:12px;
}

.note{
    background:#F9FAFB;
    border-left:4px solid #2563EB;
    padding:15px;
    border-radius:8px;
    margin-top:25px;
    font-size:14px;
}

.note.danger{
    border-left-color:#DC2626;
}

.note.success{
    border-left-color:#16A34A;
}

.cta{
    display:inline-block;
    padding:12px 24px;
    background:#2563EB;
    color:#fff !important;
    text-decoration:none;
    border-radius:8px;
    font-weight:bold;
    margin-top:10px;
}

.footer{
    background:#F9FAFB;
    text-align:center;
    padding:25px;
    font-size:13px;
    color:#6B7280;
}

.footer a{
    color:#2563EB;
    text-decoration:none;
}

</style>
</head>

<body>

<div class="container">

    <div class="header">
        <div class="logo">
            Socket Moni
        </div>
        <p>Secure Cooperative Platform</p>
    </div>

    <div class="body">
        <h2 class="greeting">${heading}</h2>
        ${bodyHtml}
    </div>

    <div class="footer">
        <strong>Socket Moni</strong><br>
        Secure. Simple. Reliable.
        <br><br>

        Need help?
        <a href="mailto:support@socketmoni.com">
            Contact Support
        </a>
    </div>

</div>

</body>
</html>
`;
}

module.exports = { wrapEmail };
