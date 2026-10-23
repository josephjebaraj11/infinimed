/**
 * Clinical concept library. Each concept names one clinical idea and every LOINC code under which
 * sources record it, with the canonical unit values are normalised to. Vital signs follow the HL7
 * vital-signs profile; laboratory concepts cover common chronic-care and screening panels.
 *
 * Adding a concept is data-only: append an entry. Codes are matched after system normalisation, so
 * `urn:oid:2.16.840.1.113883.6.1` and `http://loinc.org` are equivalent.
 */

export type ConceptCategory = "vital-signs" | "laboratory" | "social-history" | "survey";

export type Concept = {
  code: string;
  display: string;
  category: ConceptCategory;
  loinc: string[];
  unit: string;
  valueType: "quantity" | "coded";
  /** For values recorded as components of a panel (blood pressure). */
  componentOf?: string[];
  /** Plausible range in the canonical unit; values outside are flagged, not dropped. */
  plausible?: [number, number];
};

export const CONCEPTS: Concept[] = [
  // Vital signs
  { code: "body_weight", display: "Body weight", category: "vital-signs", loinc: ["29463-7", "3141-9", "8350-1", "8351-9"], unit: "kg", valueType: "quantity", plausible: [0.3, 500] },
  { code: "body_height", display: "Body height", category: "vital-signs", loinc: ["8302-2", "3137-7", "8306-3", "8308-9"], unit: "cm", valueType: "quantity", plausible: [20, 260] },
  { code: "bmi", display: "Body mass index", category: "vital-signs", loinc: ["39156-5"], unit: "kg/m2", valueType: "quantity", plausible: [8, 120] },
  { code: "bp_systolic", display: "Systolic blood pressure", category: "vital-signs", loinc: ["8480-6"], componentOf: ["85354-9", "55284-4", "35094-2"], unit: "mm[Hg]", valueType: "quantity", plausible: [40, 300] },
  { code: "bp_diastolic", display: "Diastolic blood pressure", category: "vital-signs", loinc: ["8462-4"], componentOf: ["85354-9", "55284-4", "35094-2"], unit: "mm[Hg]", valueType: "quantity", plausible: [20, 200] },
  { code: "heart_rate", display: "Heart rate", category: "vital-signs", loinc: ["8867-4"], unit: "/min", valueType: "quantity", plausible: [15, 300] },
  { code: "respiratory_rate", display: "Respiratory rate", category: "vital-signs", loinc: ["9279-1"], unit: "/min", valueType: "quantity", plausible: [3, 100] },
  { code: "body_temperature", display: "Body temperature", category: "vital-signs", loinc: ["8310-5", "8331-1", "8332-9", "8333-7"], unit: "Cel", valueType: "quantity", plausible: [25, 45] },
  { code: "oxygen_saturation", display: "Oxygen saturation", category: "vital-signs", loinc: ["59408-5", "2708-6"], unit: "%", valueType: "quantity", plausible: [40, 100] },
  { code: "head_circumference", display: "Head circumference", category: "vital-signs", loinc: ["9843-4", "8287-5"], unit: "cm", valueType: "quantity", plausible: [20, 70] },
  // Diabetes and metabolic
  { code: "hba1c", display: "Hemoglobin A1c", category: "laboratory", loinc: ["4548-4", "17856-6", "4549-2", "59261-8", "41995-2"], unit: "%", valueType: "quantity", plausible: [3, 20] },
  { code: "glucose", display: "Glucose", category: "laboratory", loinc: ["2345-7", "2339-0", "1558-6", "41653-7", "15074-8", "14749-6", "14771-0"], unit: "mg/dL", valueType: "quantity", plausible: [10, 2000] },
  // Lipids
  { code: "total_cholesterol", display: "Total cholesterol", category: "laboratory", loinc: ["2093-3", "14647-2"], unit: "mg/dL", valueType: "quantity", plausible: [40, 1000] },
  { code: "ldl", display: "LDL cholesterol", category: "laboratory", loinc: ["13457-7", "18262-6", "2089-1", "22748-8"], unit: "mg/dL", valueType: "quantity", plausible: [5, 800] },
  { code: "hdl", display: "HDL cholesterol", category: "laboratory", loinc: ["2085-9", "14646-4"], unit: "mg/dL", valueType: "quantity", plausible: [5, 200] },
  { code: "triglycerides", display: "Triglycerides", category: "laboratory", loinc: ["2571-8", "14927-8"], unit: "mg/dL", valueType: "quantity", plausible: [10, 10000] },
  // Renal
  { code: "creatinine", display: "Creatinine", category: "laboratory", loinc: ["2160-0", "38483-4", "14682-9"], unit: "mg/dL", valueType: "quantity", plausible: [0.05, 30] },
  { code: "egfr", display: "Estimated glomerular filtration rate", category: "laboratory", loinc: ["33914-3", "48642-3", "48643-1", "62238-1", "98979-8", "69405-9", "77147-7"], unit: "mL/min/{1.73_m2}", valueType: "quantity", plausible: [1, 200] },
  { code: "bun", display: "Blood urea nitrogen", category: "laboratory", loinc: ["3094-0", "6299-2"], unit: "mg/dL", valueType: "quantity", plausible: [1, 300] },
  { code: "uacr", display: "Urine albumin/creatinine ratio", category: "laboratory", loinc: ["9318-7", "14959-1", "32294-1", "14958-3"], unit: "mg/g", valueType: "quantity", plausible: [0, 20000] },
  // Electrolytes
  { code: "sodium", display: "Sodium", category: "laboratory", loinc: ["2951-2", "2947-0"], unit: "mmol/L", valueType: "quantity", plausible: [90, 200] },
  { code: "potassium", display: "Potassium", category: "laboratory", loinc: ["2823-3", "6298-4"], unit: "mmol/L", valueType: "quantity", plausible: [1, 10] },
  { code: "chloride", display: "Chloride", category: "laboratory", loinc: ["2075-0", "2069-3"], unit: "mmol/L", valueType: "quantity", plausible: [60, 150] },
  { code: "bicarbonate", display: "Bicarbonate (total CO2)", category: "laboratory", loinc: ["2028-9", "1963-8", "20565-8"], unit: "mmol/L", valueType: "quantity", plausible: [2, 60] },
  { code: "calcium", display: "Calcium", category: "laboratory", loinc: ["17861-6", "49765-1"], unit: "mg/dL", valueType: "quantity", plausible: [2, 20] },
  // Liver
  { code: "alt", display: "Alanine aminotransferase (ALT)", category: "laboratory", loinc: ["1742-6", "1743-4", "1744-2"], unit: "U/L", valueType: "quantity", plausible: [0, 20000] },
  { code: "ast", display: "Aspartate aminotransferase (AST)", category: "laboratory", loinc: ["1920-8", "30239-8"], unit: "U/L", valueType: "quantity", plausible: [0, 20000] },
  { code: "alkaline_phosphatase", display: "Alkaline phosphatase", category: "laboratory", loinc: ["6768-6"], unit: "U/L", valueType: "quantity", plausible: [0, 5000] },
  { code: "bilirubin_total", display: "Total bilirubin", category: "laboratory", loinc: ["1975-2", "42719-5"], unit: "mg/dL", valueType: "quantity", plausible: [0, 50] },
  { code: "albumin", display: "Albumin", category: "laboratory", loinc: ["1751-7", "61151-7"], unit: "g/dL", valueType: "quantity", plausible: [0.5, 8] },
  // Hematology and coagulation
  { code: "hemoglobin", display: "Hemoglobin", category: "laboratory", loinc: ["718-7", "20509-6"], unit: "g/dL", valueType: "quantity", plausible: [2, 25] },
  { code: "hematocrit", display: "Hematocrit", category: "laboratory", loinc: ["4544-3", "20570-8", "31100-1"], unit: "%", valueType: "quantity", plausible: [5, 75] },
  { code: "wbc", display: "White blood cell count", category: "laboratory", loinc: ["6690-2", "26464-8", "804-5"], unit: "10*3/uL", valueType: "quantity", plausible: [0, 500] },
  { code: "platelets", display: "Platelet count", category: "laboratory", loinc: ["777-3", "26515-7", "49497-1"], unit: "10*3/uL", valueType: "quantity", plausible: [0, 3000] },
  { code: "inr", display: "INR", category: "laboratory", loinc: ["6301-6", "34714-6", "46418-0"], unit: "{INR}", valueType: "quantity", plausible: [0.5, 15] },
  // Endocrine, nutrition, other
  { code: "tsh", display: "Thyroid stimulating hormone", category: "laboratory", loinc: ["3016-3", "11580-8"], unit: "m[IU]/L", valueType: "quantity", plausible: [0, 500] },
  { code: "free_t4", display: "Free thyroxine (T4)", category: "laboratory", loinc: ["3024-7"], unit: "ng/dL", valueType: "quantity", plausible: [0, 20] },
  { code: "vitamin_d", display: "25-hydroxyvitamin D", category: "laboratory", loinc: ["1989-3", "62292-8", "35365-6"], unit: "ng/mL", valueType: "quantity", plausible: [1, 300] },
  { code: "vitamin_b12", display: "Vitamin B12", category: "laboratory", loinc: ["2132-9"], unit: "pg/mL", valueType: "quantity", plausible: [10, 5000] },
  { code: "ferritin", display: "Ferritin", category: "laboratory", loinc: ["2276-4", "20567-4"], unit: "ng/mL", valueType: "quantity", plausible: [0, 100000] },
  { code: "psa", display: "Prostate specific antigen", category: "laboratory", loinc: ["2857-1", "35741-8", "83112-3"], unit: "ng/mL", valueType: "quantity", plausible: [0, 10000] },
  { code: "crp", display: "C-reactive protein", category: "laboratory", loinc: ["1988-5", "30522-7", "76485-2"], unit: "mg/L", valueType: "quantity", plausible: [0, 1000] },
  // Social history and surveys
  { code: "smoking_status", display: "Tobacco smoking status", category: "social-history", loinc: ["72166-2"], unit: "", valueType: "coded" },
  { code: "pregnancy_status", display: "Pregnancy status", category: "social-history", loinc: ["82810-3"], unit: "", valueType: "coded" },
  { code: "pain_score", display: "Pain severity (0-10)", category: "survey", loinc: ["72514-3", "38208-5"], unit: "{score}", valueType: "quantity", plausible: [0, 10] },
  { code: "phq9_total", display: "PHQ-9 total score", category: "survey", loinc: ["44261-6"], unit: "{score}", valueType: "quantity", plausible: [0, 27] },
  { code: "gad7_total", display: "GAD-7 total score", category: "survey", loinc: ["70274-6"], unit: "{score}", valueType: "quantity", plausible: [0, 21] },
];

export const CONCEPT_BY_CODE = new Map(CONCEPTS.map((c) => [c.code, c]));
