//! Explicit, lossless text codec support for Yedit's local source files.
//!
//! The list follows the broadly implemented WHATWG/encoding_rs repertoire,
//! plus clear UTF-8 and UTF-16 BOM variants.  We reject malformed input and
//! unrepresentable saves rather than silently replacing characters.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

#[derive(Clone, Debug)]
pub struct DecodedText {
    pub content: String,
    /// Canonical codec used for this document. This becomes its next-save
    /// encoding unless the user explicitly chooses another one.
    pub encoding: String,
}

fn codec_error(message: impl Into<String>) -> String {
    message.into()
}

pub fn normalize_encoding(requested: Option<&str>) -> Result<String, String> {
    let value = requested.unwrap_or("auto").trim().to_ascii_lowercase();
    let normalized = match value.as_str() {
        "" | "auto" | "detect" => "auto",
        "utf8" | "utf-8" => "utf-8",
        "utf8-bom" | "utf-8-bom" => "utf-8-bom",
        "utf16le" | "utf-16le" => "utf-16le",
        "utf16le-bom" | "utf-16le-bom" => "utf-16le-bom",
        "utf16be" | "utf-16be" => "utf-16be",
        "utf16be-bom" | "utf-16be-bom" => "utf-16be-bom",
        "latin1" | "latin-1" | "iso8859-1" | "iso-8859-1" | "windows-1252" | "cp1252" => {
            "windows-1252"
        }
        "iso8859-2" | "iso-8859-2" => "iso-8859-2",
        "iso8859-3" | "iso-8859-3" => "iso-8859-3",
        "iso8859-4" | "iso-8859-4" => "iso-8859-4",
        "iso8859-5" | "iso-8859-5" => "iso-8859-5",
        "iso8859-6" | "iso-8859-6" => "iso-8859-6",
        "iso8859-7" | "iso-8859-7" => "iso-8859-7",
        "iso8859-8" | "iso-8859-8" => "iso-8859-8",
        "iso8859-8-i" | "iso-8859-8-i" => "iso-8859-8-i",
        "iso8859-9" | "iso-8859-9" | "windows-1254" | "cp1254" => "windows-1254",
        "iso8859-10" | "iso-8859-10" => "iso-8859-10",
        "iso8859-11" | "iso-8859-11" | "windows-874" | "cp874" => "windows-874",
        "iso8859-13" | "iso-8859-13" => "iso-8859-13",
        "iso8859-14" | "iso-8859-14" => "iso-8859-14",
        "iso8859-15" | "iso-8859-15" => "iso-8859-15",
        "iso8859-16" | "iso-8859-16" => "iso-8859-16",
        "windows-1250" | "cp1250" => "windows-1250",
        "windows-1251" | "cp1251" => "windows-1251",
        "windows-1253" | "cp1253" => "windows-1253",
        "windows-1255" | "cp1255" => "windows-1255",
        "windows-1256" | "cp1256" => "windows-1256",
        "windows-1257" | "cp1257" => "windows-1257",
        "windows-1258" | "cp1258" => "windows-1258",
        "macintosh" | "macroman" | "mac-roman" => "macintosh",
        "x-mac-cyrillic" | "mac-cyrillic" => "x-mac-cyrillic",
        "koi8-r" | "koi8r" => "koi8-r",
        "koi8-u" | "koi8u" => "koi8-u",
        "ibm866" | "cp866" | "dos-866" => "ibm866",
        "iso-2022-jp" | "iso2022jp" => "iso-2022-jp",
        "shift_jis" | "shift-jis" | "sjis" | "cp932" => "shift_jis",
        "euc-jp" | "eucjp" => "euc-jp",
        "euc-kr" | "euckr" | "cp949" => "euc-kr",
        "big5" | "big-5" => "big5",
        "gbk" | "cp936" => "gbk",
        "gb18030" => "gb18030",
        _ => {
            return Err(codec_error(
                "Choose one of Yedit's supported character encodings.",
            ))
        }
    };
    Ok(normalized.to_owned())
}

fn legacy_codec(label: &str) -> Result<&'static Encoding, String> {
    match label {
        "utf-8" | "utf-8-bom" => Ok(UTF_8),
        "utf-16le" | "utf-16le-bom" => Ok(UTF_16LE),
        "utf-16be" | "utf-16be-bom" => Ok(UTF_16BE),
        value => Encoding::for_label(value.as_bytes())
            .ok_or_else(|| codec_error("That character encoding is unavailable in this build.")),
    }
}

fn decode_utf16(bytes: &[u8], little_endian: bool, label: &str) -> Result<String, String> {
    if bytes.len() % 2 != 0 {
        return Err(codec_error(format!(
            "That file has an incomplete {label} code unit."
        )));
    }
    let units = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect::<Vec<_>>();
    let mut content = String::from_utf16(&units)
        .map_err(|_| codec_error(format!("That file is not valid {label} text.")))?;
    if content.starts_with('\u{feff}') {
        content.remove(0);
    }
    Ok(content)
}

fn decode_as(bytes: &[u8], label: &str) -> Result<String, String> {
    match label {
        "utf-8" | "utf-8-bom" => {
            let bytes = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { bytes };
            String::from_utf8(bytes.to_vec())
                .map_err(|_| codec_error("That file is not valid UTF-8. Choose the correct opening encoding."))
        }
        "utf-16le" | "utf-16le-bom" => decode_utf16(bytes, true, "UTF-16LE"),
        "utf-16be" | "utf-16be-bom" => decode_utf16(bytes, false, "UTF-16BE"),
        _ => legacy_codec(label)?
            .decode_without_bom_handling_and_without_replacement(bytes)
            .map(|decoded| decoded.into_owned())
            .ok_or_else(|| codec_error(format!("That file has invalid {label} byte sequences. Choose another opening encoding."))),
    }
}

pub fn decode(bytes: &[u8], requested: Option<&str>) -> Result<DecodedText, String> {
    let requested = normalize_encoding(requested)?;
    if requested != "auto" {
        return Ok(DecodedText {
            content: decode_as(bytes, &requested)?,
            encoding: requested,
        });
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Ok(DecodedText {
            content: decode_as(bytes, "utf-8-bom")?,
            encoding: "utf-8-bom".to_owned(),
        });
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Ok(DecodedText {
            content: decode_as(&bytes[2..], "utf-16le-bom")?,
            encoding: "utf-16le-bom".to_owned(),
        });
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Ok(DecodedText {
            content: decode_as(&bytes[2..], "utf-16be-bom")?,
            encoding: "utf-16be-bom".to_owned(),
        });
    }
    if let Ok(content) = std::str::from_utf8(bytes) {
        return Ok(DecodedText {
            content: content.to_owned(),
            encoding: "utf-8".to_owned(),
        });
    }
    Ok(DecodedText {
        content: decode_as(bytes, "windows-1252")?,
        encoding: "windows-1252".to_owned(),
    })
}

pub fn encode(content: &str, requested: Option<&str>) -> Result<(Vec<u8>, String), String> {
    let mut encoding = normalize_encoding(requested)?;
    if encoding == "auto" {
        encoding = "utf-8".to_owned();
    }
    let mut output = match encoding.as_str() {
        "utf-8" => content.as_bytes().to_vec(),
        "utf-8-bom" => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(content.as_bytes());
            bytes
        }
        "utf-16le" | "utf-16le-bom" => {
            let mut bytes = Vec::with_capacity(content.len() * 2 + 2);
            if encoding.ends_with("-bom") {
                bytes.extend_from_slice(&[0xFF, 0xFE]);
            }
            for unit in content.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            bytes
        }
        "utf-16be" | "utf-16be-bom" => {
            let mut bytes = Vec::with_capacity(content.len() * 2 + 2);
            if encoding.ends_with("-bom") {
                bytes.extend_from_slice(&[0xFE, 0xFF]);
            }
            for unit in content.encode_utf16() {
                bytes.extend_from_slice(&unit.to_be_bytes());
            }
            bytes
        }
        _ => {
            let (encoded, _, had_errors) = legacy_codec(&encoding)?.encode(content);
            if had_errors {
                return Err(codec_error(format!("This document contains characters that cannot be saved as {encoding}. Choose UTF-8 or another capable encoding.")));
            }
            encoded.into_owned()
        }
    };
    // Keep an empty output owned and ready for no-follow writes.
    output.shrink_to_fit();
    Ok((output, encoding))
}

#[cfg(test)]
mod tests {
    use super::{decode, encode};

    #[test]
    fn auto_detects_utf8_bom_and_preserves_it_for_saving() {
        let decoded = decode(&[0xEF, 0xBB, 0xBF, b'o', b'k'], None).unwrap();
        assert_eq!(decoded.content, "ok");
        assert_eq!(decoded.encoding, "utf-8-bom");
        assert_eq!(
            encode(&decoded.content, Some(&decoded.encoding)).unwrap().0,
            vec![0xEF, 0xBB, 0xBF, b'o', b'k']
        );
    }

    #[test]
    fn decodes_utf16_and_rejects_lossy_legacy_writes() {
        let decoded = decode(&[0xFF, 0xFE, b'A', 0], None).unwrap();
        assert_eq!(decoded.content, "A");
        assert_eq!(decoded.encoding, "utf-16le-bom");
        assert!(encode("plain 🎉", Some("iso-8859-2")).is_err());
    }
}
