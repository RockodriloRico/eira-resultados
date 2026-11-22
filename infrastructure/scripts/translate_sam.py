"""Traduce template.yaml con el traductor local de SAM, sin credenciales ni llamadas a AWS.

Uso: python scripts/translate_sam.py template.yaml salida.json
La salida permite ejecutar cfn-lint sobre el CloudFormation resultante (recursos generados
por SAM como Stage, permisos y OpenAPI), que `sam validate --lint` no revisa por completo.
"""

import json
import os
import sys

from samtranslator.translator.transform import transform
from samtranslator.yaml_helper import yaml_parse

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")


class OfflineManagedPolicyLoader:
    def load(self):
        raise RuntimeError("La plantilla no debe depender de políticas administradas de AWS")


def main(source: str, target: str) -> None:
    with open(source, encoding="utf-8") as handle:
        template = yaml_parse(handle.read())
    # El traductor exige un URI S3; sam build/package lo sustituyen en un flujo real.
    template["Globals"]["Function"]["CodeUri"] = "s3://offline-placeholder/bundle.zip"
    translated = transform(template, {}, OfflineManagedPolicyLoader())
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(translated, handle, indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
