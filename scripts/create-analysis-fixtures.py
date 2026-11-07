"""Create static, self-authored domain cases. Development requires reportlab."""
import json
from pathlib import Path
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import simpleSplit

ROOT = Path(__file__).resolve().parents[1]
cases = json.loads((ROOT / 'fixtures/analysis-cases.json').read_text())['cases']
out = ROOT / 'public/analysis-fixtures.pdf'
canvas = Canvas(str(out), pagesize=(612, 792), invariant=1)
canvas.setTitle('Lemma Real Analysis Verification Cases')
canvas.setAuthor('Lemma self-authored domain cases')
for item in cases:
    canvas.setFont('Times-Roman', 9)
    canvas.drawString(60, 744, 'SELF-AUTHORED DOMAIN CASE - NOT A RESEARCH PAPER')
    canvas.setFont('Times-Bold', 20)
    canvas.drawString(60, 688, item['label'] + ' - Continuity and compactness')
    y = 635
    canvas.setFont('Times-Roman', 14)
    for line in simpleSplit(item['quote'], 'Times-Roman', 14, 492):
        canvas.drawString(60, y, line)
        y -= 22
    y -= 30
    canvas.setFont('Times-Roman', 12)
    for note in item['notes']:
        for line in simpleSplit(note, 'Times-Roman', 12, 492):
            canvas.drawString(60, y, line)
            y -= 19
        y -= 12
    canvas.setFont('Times-Roman', 10)
    canvas.drawString(60, 110, 'Scope: one selected claim. Original proof and semantics require separate review.')
    canvas.drawString(60, 91, 'No model has been invoked by this PDF. Formal evidence must come from an actual run.')
    canvas.showPage()
canvas.save()
print(out)
