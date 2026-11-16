import unittest

from calculer_wilayas import EXPECTED_TOTAL_QX, FIELDS, WILAYAS, normalize_table


class TestExtractionWilayas(unittest.TestCase):
    def test_codes_historiques_uniques(self):
        self.assertEqual(len(WILAYAS), 48)
        self.assertEqual(len(set(WILAYAS.values())), 48)

    def test_refuse_table_incomplete(self):
        with self.assertRaisesRegex(ValueError, "wilayas extraites"):
            normalize_table([["1 ADRAR", "0", "0", "0", "0", "0", "1", "1", "100", "10", "10"]])

    def test_refuse_total_incoherent(self):
        rows = []
        for index, (name, code) in enumerate(WILAYAS.items(), start=1):
            rows.append([f"{index} {name}", "0", "0", "0", "0", "0", "1", "1", "100", "1", "1"])
        with self.assertRaisesRegex(ValueError, "Total extrait"):
            normalize_table(rows)

    def test_schema(self):
        self.assertEqual(FIELDS[0:3], ["code_wilaya", "wilaya", "annee"])
        self.assertEqual(EXPECTED_TOTAL_QX, 56_259_902)


if __name__ == "__main__":
    unittest.main()
