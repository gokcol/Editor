"""Independent ZIP/PE/identity and every-block validation of unsigned uploads."""
import base64
import hashlib
import json
from pathlib import Path
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

folder = Path(sys.argv[1])
products = json.loads(Path('packaging/windows/msix/products.json').read_text())
ns = {'m': 'http://schemas.microsoft.com/appx/manifest/foundation/windows10'}
reports = []
for app, product in products.items():
    package = folder / f"{app}-{product['packageVersion']}-store-x64.msix"
    info = json.loads(Path(str(package) + '.json').read_text(encoding='utf-8-sig'))
    digest = hashlib.file_digest(package.open('rb'), 'sha256').hexdigest()
    assert info['sha256'] == digest and info['identityMode'] == 'store' and not info['signed']
    blocks = 0
    with zipfile.ZipFile(package) as archive:
        assert archive.testzip() is None and 'AppxSignature.p7x' not in archive.namelist()
        manifest = ET.fromstring(archive.read('AppxManifest.xml'))
        identity = manifest.find('m:Identity', ns)
        assert identity.attrib == {'Name': product['identityName'], 'Publisher': product['publisher'], 'Version': product['packageVersion'], 'ProcessorArchitecture': 'x64'}
        assert manifest.find('m:Properties/m:DisplayName', ns).text == product['displayName']
        assert manifest.find('m:Properties/m:PublisherDisplayName', ns).text == product['publisherDisplayName']
        assert manifest.find('m:Dependencies/m:TargetDeviceFamily', ns).attrib['MinVersion'] == '10.0.22000.0'
        assert [node.attrib['Name'] for node in manifest.find('m:Capabilities', ns)] == ['runFullTrust']
        assert not any(node.tag.split('}')[-1] in ('FileSystemWriteVirtualization', 'RegistryWriteVirtualization', 'StartupTask') for node in manifest.iter())
        binary = archive.read(f'{app}.exe')
        assert hashlib.sha256(binary).hexdigest() == info['binarySha256']
        assert binary[:2] == b'MZ'
        offset = struct.unpack_from('<I', binary, 0x3c)[0]
        assert binary[offset:offset+4] == b'PE\0\0' and struct.unpack_from('<H', binary, offset+4)[0] == 0x8664
        for entry in ET.fromstring(archive.read('AppxBlockMap.xml')):
            payload = archive.read(entry.attrib['Name'].replace('\\', '/'))
            assert len(payload) == int(entry.attrib['Size'])
            position = 0
            for block in entry:
                if block.tag.split('}')[-1] == 'FileHash':
                    assert base64.b64encode(hashlib.sha256(payload).digest()).decode() == block.attrib['Hash']
                    continue
                data = payload[position:position+65536]
                assert base64.b64encode(hashlib.sha256(data).digest()).decode() == block.attrib['Hash']
                position += len(data)
                blocks += 1
            assert position == len(payload)
    reports.append({'app': app, 'file': package.name, 'sha256': digest, 'bytes': package.stat().st_size,
                    'allBlockHashesVerified': blocks, 'zipCRC': 'passed', 'identity': 'matched Partner Center',
                    'capabilities': ['runFullTrust'], 'unsigned': True, 'minimumWindows': '11 x64'})
out = folder / 'independent-verification.json'
out.write_text(json.dumps(reports, indent=2) + '\n')
print(json.dumps(reports, indent=2))
