//! File › Export › PowerPoint for a Marp deck: each slide as a full-bleed picture
//! (rendered by WebKit, see pdf.rs), its speaker notes in the slide's notes. A minimal
//! Office Open XML package, written as a stored (uncompressed) ZIP: the pictures are
//! PNGs already.

/// English Metric Units per CSS pixel (914400 an inch, 96 pixels an inch).
const EMU_PER_PX: f64 = 9525.0;

/// A deck of `slides` (PNG files, in order) of `width` × `height` CSS pixels, with
/// `notes` for each, as a PowerPoint file.
pub fn package(slides: &[Vec<u8>], notes: &[String], width: f64, height: f64) -> Vec<u8> {
    let cx = (width * EMU_PER_PX).round() as u64;
    let cy = (height * EMU_PER_PX).round() as u64;
    let n = slides.len();
    let mut zip = Zip::default();

    let mut types = String::from(concat!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
        r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
        r#"<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>"#,
        r#"<Default Extension="xml" ContentType="application/xml"/>"#,
        r#"<Default Extension="png" ContentType="image/png"/>"#,
        r#"<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>"#,
        r#"<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>"#,
        r#"<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>"#,
        r#"<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>"#,
        r#"<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>"#,
        r#"<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>"#,
        r#"<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>"#,
        r#"<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>"#,
        r#"<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>"#,
        r#"<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>"#,
        r#"<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>"#,
    ));
    for i in 1..=n {
        types.push_str(&format!(
            r#"<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>"#
        ));
    }
    types.push_str("</Types>");
    zip.add("[Content_Types].xml", types.as_bytes());

    zip.add(
        "_rels/.rels",
        rels(&[
            ("rId1", "officeDocument", "ppt/presentation.xml"),
            ("rId2", "package/core-properties", "docProps/core.xml"),
            ("rId3", "extended-properties", "docProps/app.xml"),
        ])
        .as_bytes(),
    );
    zip.add(
        "docProps/core.xml",
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">"#,
            r#"<dc:creator>Marpora</dc:creator></cp:coreProperties>"#
        )
        .as_bytes(),
    );
    zip.add(
        "docProps/app.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Marpora</Application><Slides>{n}</Slides></Properties>"#
        )
        .as_bytes(),
    );

    // The presentation: master, notes master, slides and their size.
    let mut ids = String::new();
    let mut pres_rels = vec![
        (
            "rId1".to_owned(),
            "slideMaster".to_owned(),
            "slideMasters/slideMaster1.xml".to_owned(),
        ),
        (
            "rId2".to_owned(),
            "notesMaster".to_owned(),
            "notesMasters/notesMaster1.xml".to_owned(),
        ),
        (
            "rId3".to_owned(),
            "theme".to_owned(),
            "theme/theme1.xml".to_owned(),
        ),
        (
            "rId4".to_owned(),
            "presProps".to_owned(),
            "presProps.xml".to_owned(),
        ),
        (
            "rId5".to_owned(),
            "viewProps".to_owned(),
            "viewProps.xml".to_owned(),
        ),
        (
            "rId6".to_owned(),
            "tableStyles".to_owned(),
            "tableStyles.xml".to_owned(),
        ),
    ];
    for i in 1..=n {
        let rid = format!("rId{}", 6 + i);
        ids.push_str(&format!(r#"<p:sldId id="{}" r:id="{rid}"/>"#, 255 + i));
        pres_rels.push((rid, "slide".to_owned(), format!("slides/slide{i}.xml")));
    }
    zip.add(
        "ppt/presentation.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation {NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx="{cx}" cy="{cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>"#
        )
        .as_bytes(),
    );
    let pres_rels: Vec<(&str, &str, &str)> = pres_rels
        .iter()
        .map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str()))
        .collect();
    zip.add(
        "ppt/_rels/presentation.xml.rels",
        rels(&pres_rels).as_bytes(),
    );
    zip.add(
        "ppt/presProps.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr {NS}/>"#
        )
        .as_bytes(),
    );
    zip.add(
        "ppt/viewProps.xml",
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr {NS}/>"#)
            .as_bytes(),
    );
    zip.add(
        "ppt/tableStyles.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>"#.as_bytes(),
    );

    // One blank master and layout; the slides draw everything as their picture.
    zip.add(
        "ppt/slideMasters/slideMaster1.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster {NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>{GROUP}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>"#
        )
        .as_bytes(),
    );
    zip.add(
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        rels(&[
            ("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
            ("rId2", "theme", "../theme/theme1.xml"),
        ])
        .as_bytes(),
    );
    zip.add(
        "ppt/slideLayouts/slideLayout1.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout {NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>{GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#
        )
        .as_bytes(),
    );
    zip.add(
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        rels(&[("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")]).as_bytes(),
    );
    zip.add(
        "ppt/notesMasters/notesMaster1.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notesMaster {NS}><p:cSld><p:spTree>{GROUP}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>"#
        )
        .as_bytes(),
    );
    zip.add(
        "ppt/notesMasters/_rels/notesMaster1.xml.rels",
        rels(&[("rId1", "theme", "../theme/theme2.xml")]).as_bytes(),
    );
    zip.add("ppt/theme/theme1.xml", THEME.as_bytes());
    zip.add("ppt/theme/theme2.xml", THEME.as_bytes());

    for (i, png) in slides.iter().enumerate() {
        let i = i + 1;
        zip.add(&format!("ppt/media/image{i}.png"), png);
        zip.add(
            &format!("ppt/slides/slide{i}.xml"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld {NS}><p:cSld><p:spTree>{GROUP}<p:pic><p:nvPicPr><p:cNvPr id="2" name="Slide {i}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#
            )
            .as_bytes(),
        );
        zip.add(
            &format!("ppt/slides/_rels/slide{i}.xml.rels"),
            rels(&[
                ("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"),
                ("rId2", "image", &format!("../media/image{i}.png")),
                (
                    "rId3",
                    "notesSlide",
                    &format!("../notesSlides/notesSlide{i}.xml"),
                ),
            ])
            .as_bytes(),
        );
        let paragraphs: String = notes
            .get(i - 1)
            .map(String::as_str)
            .unwrap_or("")
            .lines()
            .map(|l| {
                format!(
                    r#"<a:p><a:r><a:rPr lang="en-US"/><a:t>{}</a:t></a:r></a:p>"#,
                    escape(l)
                )
            })
            .collect();
        let paragraphs = if paragraphs.is_empty() {
            "<a:p/>".to_owned()
        } else {
            paragraphs
        };
        zip.add(
            &format!("ppt/notesSlides/notesSlide{i}.xml"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes {NS}><p:cSld><p:spTree>{GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>{paragraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"#
            )
            .as_bytes(),
        );
        zip.add(
            &format!("ppt/notesSlides/_rels/notesSlide{i}.xml.rels"),
            rels(&[
                ("rId1", "notesMaster", "../notesMasters/notesMaster1.xml"),
                ("rId2", "slide", &format!("../slides/slide{i}.xml")),
            ])
            .as_bytes(),
        );
    }
    zip.finish()
}

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#;

/// The shape tree's own group properties, which every tree starts with.
const GROUP: &str = r#"<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>"#;

/// Relationships: id, type (under officeDocument's relationship URI, or a package one),
/// target.
fn rels(list: &[(&str, &str, &str)]) -> String {
    let mut out = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for (id, kind, target) in list {
        let uri = match kind.strip_prefix("package/") {
            Some(k) => {
                format!("http://schemas.openxmlformats.org/package/2006/relationships/metadata/{k}")
            }
            None => format!(
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}"
            ),
        };
        out.push_str(&format!(
            r#"<Relationship Id="{id}" Type="{uri}" Target="{target}"/>"#
        ));
    }
    out.push_str("</Relationships>");
    out
}

fn escape(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .fold(String::new(), |mut out, c| {
            match c {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '"' => out.push_str("&quot;"),
                c => out.push(c),
            }
            out
        })
}

/// A plain Office theme: the colours, fonts and formats a master needs to point at.
const THEME: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
    r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Marpora"><a:themeElements>"#,
    r#"<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>"#,
    r#"<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>"#,
    r#"<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>"#,
    r#"<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>"#,
    r#"<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>"#,
    r#"<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>"#,
    r#"<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>"#,
    r#"<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>"#,
    r#"<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>"#,
    r#"<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>"#,
    r#"<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>"#,
    r#"<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>"#,
    r#"</a:fmtScheme></a:themeElements></a:theme>"#
);

/// A ZIP archive with stored entries.
#[derive(Default)]
struct Zip {
    data: Vec<u8>,
    central: Vec<u8>,
    count: u16,
}

impl Zip {
    fn add(&mut self, name: &str, body: &[u8]) {
        let crc = crc32(body);
        let offset = self.data.len() as u32;
        let size = body.len() as u32;
        let name = name.as_bytes();
        // Version 2.0, no flags, stored, DOS time 0 (1980-01-01).
        let common = |out: &mut Vec<u8>| {
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0x21u16.to_le_bytes());
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
        };
        self.data.extend_from_slice(&0x04034b50u32.to_le_bytes());
        common(&mut self.data);
        self.data.extend_from_slice(name);
        self.data.extend_from_slice(body);

        self.central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        self.central.extend_from_slice(&20u16.to_le_bytes());
        common(&mut self.central);
        // Comment length, disk, internal and external attributes, offset.
        self.central.extend_from_slice(&0u16.to_le_bytes());
        self.central.extend_from_slice(&0u16.to_le_bytes());
        self.central.extend_from_slice(&0u16.to_le_bytes());
        self.central.extend_from_slice(&0u32.to_le_bytes());
        self.central.extend_from_slice(&offset.to_le_bytes());
        self.central.extend_from_slice(name);
        self.count += 1;
    }

    fn finish(mut self) -> Vec<u8> {
        let start = self.data.len() as u32;
        let size = self.central.len() as u32;
        self.data.append(&mut self.central);
        self.data.extend_from_slice(&0x06054b50u32.to_le_bytes());
        self.data.extend_from_slice(&0u16.to_le_bytes());
        self.data.extend_from_slice(&0u16.to_le_bytes());
        self.data.extend_from_slice(&self.count.to_le_bytes());
        self.data.extend_from_slice(&self.count.to_le_bytes());
        self.data.extend_from_slice(&size.to_le_bytes());
        self.data.extend_from_slice(&start.to_le_bytes());
        self.data.extend_from_slice(&0u16.to_le_bytes());
        self.data
    }
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_the_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn package_lists_every_part() {
        let bytes = package(
            &[vec![1, 2, 3], vec![4]],
            &["Say hi\nthen <go>".into()],
            1280.0,
            720.0,
        );
        let text = String::from_utf8_lossy(&bytes);
        for part in [
            "[Content_Types].xml",
            "ppt/presentation.xml",
            "ppt/slides/slide2.xml",
            "ppt/media/image1.png",
            "ppt/notesSlides/notesSlide1.xml",
        ] {
            assert!(text.contains(part), "{part}");
        }
        assert!(text.contains(r#"<p:sldSz cx="12192000" cy="6858000"/>"#));
        assert!(text.contains("<a:t>then &lt;go&gt;</a:t>"));
        // The end of central directory record counts the entries.
        let eocd = bytes.len() - 22;
        assert_eq!(&bytes[eocd..eocd + 4], &0x06054b50u32.to_le_bytes());
        let entries = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]);
        assert_eq!(usize::from(entries), 17 + 2 * 5);
    }
}
