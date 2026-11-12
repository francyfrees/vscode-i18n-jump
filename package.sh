#!/bin/bash
# 只打包 vsix（不安装）：CI 与 build.sh 共用
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(node -p "require('./package.json').version")
OUT="i18n-jump-$VERSION.vsix"

rm -rf .build
mkdir -p .build/extension
cp package.json extension.js README.md LICENSE .build/extension/
[ -d docs ] && cp -R docs .build/extension/

cat > .build/extension.vsixmanifest <<MANIFEST
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="i18n-jump" Version="$VERSION" Publisher="local" />
    <DisplayName>i18n Jump</DisplayName>
    <Description xml:space="preserve">悬停查看翻译、Cmd+点击跳到词条、中文内联提示</Description>
    <Tags>i18n,translation</Tags>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.80.0" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
MANIFEST

cat > '.build/[Content_Types].xml' <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="png" ContentType="image/png" />
</Types>
XML

(cd .build && zip -qr "../$OUT" extension.vsixmanifest '[Content_Types].xml' extension)
rm -rf .build
echo "$OUT"
