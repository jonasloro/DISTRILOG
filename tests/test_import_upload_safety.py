"""Upload edge cases without parsing real operational documents."""
import asyncio
import io

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile

from unified_module import read_limited_upload, read_pdf_text


def upload(name: str, data: bytes) -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(data))


def test_pdf_extension_and_signature_are_checked():
    with pytest.raises(HTTPException) as err:
        asyncio.run(read_limited_upload(upload("operacao.exe", b"%PDF-1.7")))
    assert err.value.status_code == 415
    with pytest.raises(HTTPException) as err:
        asyncio.run(read_limited_upload(upload("operacao.pdf", b"not-a-pdf")))
    assert err.value.status_code == 415


def test_oversized_and_empty_pdf_fail_before_parser():
    with pytest.raises(HTTPException) as err:
        asyncio.run(read_limited_upload(upload("empty.pdf",b"")))
    assert err.value.status_code == 413
    with pytest.raises(HTTPException) as err:
        asyncio.run(read_limited_upload(upload("large.pdf",b"%PDF-1.7"+b"x"*(10*1024*1024))))
    assert err.value.status_code == 413


def test_excel_signature_and_max_size():
    with pytest.raises(HTTPException) as err:
        asyncio.run(read_limited_upload(upload("compras.xlsx",b"not-a-zip"),pdf=False))
    assert err.value.status_code == 415
    assert asyncio.run(read_limited_upload(upload("compras.xlsx",b"PK\x03\x04minimal"),pdf=False)).startswith(b"PK")


def test_corrupt_pdf_is_safe_error():
    with pytest.raises(HTTPException) as err:
        read_pdf_text(b"%PDF-invalid")
    assert err.value.status_code == 400
    assert "arquivo" not in str(err.value.detail).lower()
