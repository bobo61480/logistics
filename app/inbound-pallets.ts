// Verified from ER 11차 패킹리스트.xlsx (modified 2026-03-13).
// Blank PLT NO. cells inherit the most recent numbered pallet in the packing list.
const PALLETS_BY_SHIPMENT: Record<string, Record<string, string[]>> = {
  ER11: {
    "ABIBP20-MEYE": ["20"],
    "ABIBS20-I": ["20"],
    "ACPS05-PTCR": ["16"],
    "ALSS12-S": ["13"],
    "ANS10-CPH": ["20"],
    "ANS10-PATCHTA": ["20"],
    "ANS10-SAZ": ["20"],
    "BETC05-SC": ["16"],
    "CCBMA02-GC": ["19"],
    "CMXS06-TR": ["4", "20"],
    "CMXS08-BS": ["4"],
    "CMXS09-VB": ["4"],
    "DRAS01-M100": ["20"],
    "DRAS01-SABC": ["9", "11", "13"],
    "EC34-SCRR": ["19"],
    "EC55-WF250RE": ["17"],
    "EC64-LI25": ["16"],
    "ECM04-L03": ["16"],
    "ECM04-WG02": ["16"],
    "ECM04-WG03": ["17"],
    "ECM04-WG04": ["16"],
    "ECM04-WG05": ["16"],
    "ECM102-K01R": ["16"],
    "ECM102-K02RE": ["17"],
    "ECM102-K04": ["16"],
    "ECM116-E01P": ["16", "19"],
    "ECM116-E03P": ["16", "19"],
    "ECM116-E04P": ["16"],
    "ECM116-E05P": ["16", "19"],
    "ECM116-E06P": ["16"],
    "ECM116-E07P": ["16"],
    "ECM195-I04": ["17"],
    "ECM61-KSRR": ["16", "19"],
    "ECM84-KARR": ["17"],
    "EM125-CR02R": ["19"],
    "EM16-B11": ["17"],
    "EMA87-BH01": ["19"],
    "EMA87-BH02": ["19"],
    "EMA87-BH03": ["19"],
    "ES01-C21": ["19"],
    "ES231-LM": ["19"],
    "ES84-01R": ["16", "19"],
    "GUHS01-AR": ["17"],
    "GUHS03-T": ["17"],
    "HLSS01-ESR": ["20"],
    "HMS23-IRB": ["20"],
    "HRC04-GEL": ["4"],
    "IDCP02-PKSTG": ["1", "3"],
    "IDCP08-PKW": ["2", "3"],
    "ISNS23-SV": ["15"],
    "KWABS01-BMB": ["19"],
    "KWABS01-BMC": ["19"],
    "KWABS01-BMP": ["19"],
    "KWABS01-BWB": ["19"],
    "KWABS01-BWC": ["19"],
    "KWABS01-BWO": ["19"],
    "LIVCM01-KG": ["16"],
    "MECUC08-F": ["20"],
    "MECUC13-F": ["5"],
    "MECUP07-MP": ["20"],
    "MECUP07-MZ": ["5", "6", "7", "15"],
    "MECUP08-PK": ["12", "14", "16"],
    "MECUP10-PKM": ["19"],
    "MECUS01-ECC": ["13"],
    "MECUS08-SR": ["15"],
    "MECUS10-C": ["5"],
    "MECUS10-SR": ["7"],
    "MECUS13-AE7500": ["20"],
    "MECUS13-CCR": ["5"],
    "MECUS13-CM": ["13"],
    "MECUS13-GEL": ["17", "18"],
    "MECUS13-I": ["18", "20"],
    "MECUS14-T": ["10", "13"],
    "MECUS17-MSR": ["13"],
    "MECUS19-SR": ["15", "19"],
    "MECUS6-CG": ["13"],
    "MMCPA05-AFP": ["19"],
    "MMCPA06-PFML": ["15"],
    "MMCPA06-PFSB": ["15"],
    "MMCPA07-AFD": ["15"],
    "MMCPA07-AFP": ["15"],
    "MMCPA07-AFPS": ["15"],
    "PRS07-GELR": ["8", "16"],
    "PYC01-CCDR": ["20"],
    "RBS21-C": ["20"],
    "SESALOHS17-HFR": ["20"],
    "TIAMS11-ER": ["20"],
    "TIRM10-C17C": ["15"],
    "TIRM23-CU13C": ["15"],
    "TIRM23-CU17N": ["15"],
    "TIRM23-CU28N": ["15"],
    "TIRM23-CU34N": ["15"],
    "TIRM23-CU35N": ["15"],
    "TIRM23-CU40N": ["15"],
    "TIRM24-CU23NRE": ["15"],
    "TIRM24-CU24N": ["15"],
    "TIRM24-CU29N": ["15"],
    "TIRM25-CU21N": ["15"],
    "TIRM25-CU23N": ["15"],
    "TIRM25-CU27N": ["15"],
    "TIRM30-CR1N": ["15"],
    "TIRM30-CR6O": ["15"],
    "TKBCM08-LR": ["20"],
    "TKBS12-IG": ["20"],
  },
};

function compact(value: string) {
  return value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

const NORMALIZED_PALLETS_BY_SHIPMENT = Object.fromEntries(
  Object.entries(PALLETS_BY_SHIPMENT).map(([shipment, products]) => [
    shipment,
    Object.fromEntries(
      Object.entries(products).map(([sku, pallets]) => [compact(sku), pallets]),
    ),
  ]),
);

function shipmentCode(value: string) {
  const cleaned = value.replace(/\s*\(rcvd[^)]*\)\s*/gi, "").trim();
  const match = cleaned.toUpperCase().match(/\b([A-Z]{2,10})\s*[- ]?\s*(\d{1,3})\b/);
  return match ? `${match[1]}${Number(match[2])}` : compact(cleaned);
}

export function packingListPallets(shipmentReferences: string, sku: string) {
  const skuKey = compact(sku);
  if (!skuKey) return "";
  return shipmentReferences
    .split(/\r?\n|,\s*/)
    .map(shipmentCode)
    .filter(Boolean)
    .flatMap((code) => {
      const pallets = NORMALIZED_PALLETS_BY_SHIPMENT[code]?.[skuKey];
      return pallets?.length ? [`${code}: ${pallets.map((pallet) => `P${pallet}`).join("/")}`] : [];
    })
    .join(" · ");
}
