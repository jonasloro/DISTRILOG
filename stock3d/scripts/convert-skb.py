"""Conversor local SketchUp .skb/.skp para GLB: jamais faz upload do arquivo."""
from pathlib import Path
from tempfile import TemporaryDirectory
import argparse
import shutil
import struct

def convert(source: Path, destination: Path):
    from openskp import SkpFile
    from openskp.export import instanced_glb
    if source.suffix.lower() not in ('.skb', '.skp') or not source.is_file():
        raise ValueError('Informe um arquivo .skb/.skp existente.')
    if destination.suffix.lower() != '.glb' or source.resolve() == destination.resolve():
        raise ValueError('O destino deve ser um arquivo GLB diferente do original.')
    with TemporaryDirectory(prefix='stock3d-') as folder:
        temporary = Path(folder) / 'model.skp'
        shutil.copyfile(source, temporary)  # O parser valida extensão .skp
        skp = SkpFile.open(temporary)
        print('Lendo estrutura...', flush=True)
        skp.parse()
        print('Gerando GLB com instâncias...', flush=True)
        instanced_glb.export(skp, str(destination), textures=False)
    with destination.open('rb') as file:
        header = file.read(12)
    if len(header) != 12:
        raise RuntimeError('GLB incompleto.')
    magic, version, size = struct.unpack('<4sII', header)
    if magic != b'glTF' or version != 2 or size != destination.stat().st_size:
        raise RuntimeError('GLB inválido ou incompleto.')
    print('GLB pronto:', destination, '(', size, 'bytes )', flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path, nargs='?')
    args = parser.parse_args()
    convert(args.source, args.destination or args.source.with_suffix('.glb'))
