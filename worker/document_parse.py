"""Local Docling extraction. Parent enforces a wall-time limit and OS sandbox."""
import hashlib
import base64
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                  TOKENIZERS_PARALLELISM="false")
source, output, model_root, selected_page = sys.argv[1:]
source, output, model_root = Path(source), Path(output), Path(model_root)
page_index = int(selected_page)
started = time.monotonic()
try:
    import torch
    torch.set_num_threads(2)
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, CodeFormulaVlmOptions
    from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice
    from docling.datamodel.vlm_engine_options import TransformersVlmEngineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    receipt = json.loads((model_root / "receipt.json").read_text())
    pins = {m["repository"]: m["revision"] for m in receipt["models"]}
    options = PdfPipelineOptions(artifacts_path=model_root, do_ocr=False,
                                 do_table_structure=False, do_formula_enrichment=True,
                                 generate_page_images=True, images_scale=1.67,
                                 enable_remote_services=False, document_timeout=300)
    options.accelerator_options = AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=2)
    options.layout_options.model_spec.revision = pins["docling-project/docling-layout-heron"]
    formula = CodeFormulaVlmOptions.from_preset("codeformulav2")
    formula.model_spec.revision = pins["docling-project/CodeFormulaV2"]
    formula.model_spec.max_new_tokens = 1024
    formula.engine_options = TransformersVlmEngineOptions(device=AcceleratorDevice.CPU,
        torch_dtype="float32", load_in_8bit=False, compile_model=False, trust_remote_code=False)
    options.code_formula_options = formula
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    result = converter.convert(source, page_range=(page_index + 1, page_index + 1), max_file_size=25 * 1024 * 1024)
    document = result.document
    items = []
    for item, _level in document.iterate_items():
        if not hasattr(item, "text"):
            continue
        entry = {"label": str(item.label.value), "text": item.text, "originalText": getattr(item, "orig", None),
                 "provenance": [p.model_dump(mode="json") for p in item.prov]}
        if item.label.value == "formula":
            image = item.get_image(document)
            if image is not None:
                import io
                buf = io.BytesIO()
                image.save(buf, format="PNG")
                crop = buf.getvalue()
                name = f"formula-{len(items)}.png"
                (output.parent / name).write_bytes(crop)
                entry["crop"] = {"file": name, "sha256": hashlib.sha256(crop).hexdigest(),
                                 "mediaType": "image/png", "width": image.width, "height": image.height,
                                 "base64": base64.b64encode(crop).decode("ascii")}
        items.append(entry)
    response = {"schemaVersion": "lemma.docling-page.v2", "status": str(result.status.value),
                "pageIndex": page_index, "paperSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "parser": {"docling": importlib.metadata.version("docling"),
                           "transformers": importlib.metadata.version("transformers"),
                           "models": [{"repository": k, "revision": v} for k, v in pins.items()],
                           "inference": "CPU_offline", "ocr": False},
                "items": items, "elapsedMs": round(1000 * (time.monotonic() - started)),
                "authority": "layout_and_formula_candidates_not_a_semantic_certificate"}
except Exception as error:
    response = {"schemaVersion": "lemma.docling-page.v1", "status": "error", "pageIndex": page_index,
                "error": {"type": type(error).__name__, "message": str(error)},
                "elapsedMs": round(1000 * (time.monotonic() - started))}
output.write_text(json.dumps(response, ensure_ascii=False, indent=2))
print(json.dumps({"status": response["status"], "elapsedMs": response["elapsedMs"]}), flush=True)
sys.exit(0 if response["status"] == "success" else 1)
