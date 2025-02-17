`import os
import sys
import json
import time
import random
import paramiko
import logging
from argparse import ArgumentParser
from urllib.parse import urlparse
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.wait import WebDriverWait
from selenium.webdriver import ActionChains
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.desired_capabilities import DesiredCapabilities

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('scraper.log'),
        logging.StreamHandler()
    ]
)

logging.info('Starting the scraper...')

class SFTPManager:
    def __init__(self, uri):
        parsed = urlparse(uri)
        self.host = parsed.hostname
        self.port = parsed.port or 22
        self.user = parsed.username
        self.pwd = parsed.password
        self.base_path = parsed.path  # Preserve leading slash

        self.transport = paramiko.Transport((self.host, self.port))
        self.transport.connect(username=self.user, password=self.pwd)
        self.sftp = paramiko.SFTPClient.from_transport(self.transport)

    def get_json(self, filename):
        """Secure JSON file download with validation"""
        # local_path = str(Path(filename).name)
        # remote_path = os.path.join(self.base_path, filename)
        local_path = Path(filename).name
        remote_path = Path(self.base_path) / filename

        try:
            self.sftp.get(str(remote_path), str(local_path))
            with open(local_path, 'r') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError) as e:
            print(f"Error loading {filename}: {str(e)}")
            raise
        except Exception as e:
            self.sftp.close()
            self.transport.close()
            raise

    def put_json(self, data, filename):
        """Atomic file update with temp file"""
        temp_file = f"{filename}.tmp"
        with open(temp_file, 'w') as f:
            json.dump(data, f, indent=2)
        
        try:
            self.sftp.put(temp_file, str(self.base_path / filename))
            Path(temp_file).unlink()
        finally:
            if Path(temp_file).exists():
                Path(temp_file).unlink()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.sftp.close()
        self.transport.close()


def human_like_delay(min_t=1, max_t=3):
    time.sleep(random.uniform(min_t, max_t))

def solve_cloudflare(driver):
    try:
        if "cloudflare" in driver.page_source.lower():
            driver.switch_to.frame(driver.find_element(By.XPATH, "//iframe[contains(@title, 'Challenge')]"))
            verify_btn = WebDriverWait(driver, 15).until(
                EC.element_to_be_clickable((By.XPATH, "//span[@class='mark']"))
            )
            ActionChains(driver).move_to_element(verify_btn).pause(1).click().perform()
            driver.switch_to.default_content()
            human_like_delay(3, 5)
            return True
    except Exception:
        return False


def process_object(driver, obj, cookies_list, local_storage_list, session_storage_list, jwt_token_value):
    """Robust element handling with full cookie injection, User-Agent, and retries"""
    for attempt in range(3):
        try:
            driver.delete_all_cookies()
            driver.execute_script("window.open('');")
            driver.close()
            driver.switch_to.window(driver.window_handles[0])
            
            # Set cookies with domain validation
            base_url = "https://rapidapi.com"
            base_domain = "rapidapi.com"
            driver.get(base_url)
            
            # Set local storage items
            for key, value in local_storage_list.items():
               driver.execute_script(f"window.localStorage.setItem('{key}', '{value}');")
               
            # Set session storage values
            for key, value in session_storage_list.items():
                driver.execute_script(f"window.sessionStorage.setItem('{key}', '{value}');")
            
            # Add cookies to the driver
            for cookie in cookies_list:
                try:
                    if cookie['domain'] not in base_domain:
                        cookie['domain'] = base_domain
                    driver.add_cookie({
                        'name': cookie['name'],
                        'value': cookie['value'],
                        'domain': cookie['domain'],
                        'secure': True,
                        'httpOnly': False,  # If HttpOnly, Selenium can't set it
                        'sameSite': 'Lax'
                    })
                except Exception as e:
                    print(f"Warning: Could not set cookie {cookie['name']}: {str(e)}")
            # Add JWT token as a cookie
            driver.add_cookie({'name': 'token', 'value': jwt_token_value, 'domain': base_domain, 'path': '/', 'secure': True, 'httpOnly': False, 'sameSite': 'Strict'})
            driver.add_cookie({'name': 'jwt_auth', 'value': jwt_token_value, 'domain': base_domain, 'path': '/', 'secure': True, 'httpOnly': False, 'sameSite': 'Strict'})
            # Print all cookies and specifically check for JWT cookie
            all_cookies = driver.get_cookies()
            print("All cookies:", all_cookies)
            jwt_cookie = next((cookie for cookie in all_cookies if cookie['name'] == 'jwt_auth'), None)
            if jwt_cookie:
                print("JWT Cookie found:", jwt_cookie['value'])
            else:
                print("JWT Cookie not found")

            # Human-like navigation pattern
            ActionChains(driver).send_keys(Keys.PAGE_DOWN).pause(1).perform()

            # Navigate to the target page
            driver.get("https://rapidapi.com/studio/api_22dd3f3e-f11a-494c-a080-228eb6f67e8c/client/4b16491c-11b6-468c-b841-03c78261b8cd")

            # Element interaction flow
            container = WebDriverWait(driver, 15).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, "div.css-vyrhqs.css-1lfcwor"))
            )
            buttons = container.find_elements(By.CSS_SELECTOR, "button.css-1tfwfkp")
            driver.execute_script("arguments[0].click()", buttons[1])
            
            endpoint_section = WebDriverWait(driver, 10).until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, "div.elrb9vu0.css-1992qbr"))
            )
            driver.execute_script("arguments[0].click()", endpoint_section)
            
            endpoint_input = WebDriverWait(driver, 10).until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, "input.css-d4v849"))
            )
            human_like_delay()
            endpoint_input.clear()
            endpoint_input.send_keys(f'https://api.dz.com/api/{obj["slug"]}')
            
            # Description section
            desc_button = driver.find_element(By.XPATH, '//button[.//div[text()="Description"]]')
            desc_button.click()
            
            title_input = WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.CLASS_NAME, 'css-d4v849'))
            )
            title_input.clear()
            title_input.send_keys(obj['title']['en'])
            
            description_area = driver.find_element(By.CSS_SELECTOR, 'textarea.css-1ccau2i')
            description_area.clear()
            description_area.send_keys(obj['description']['en'])
            
            # Auth section
            auth_button = driver.find_element(By.XPATH, '//button[.//div[text()="Auth"]]')
            auth_button.click()
            
            bearer_button = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.XPATH, '//button[.//div[text()="Bearer"]]'))
            )
            bearer_button.click()
            
            token_input = WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, '.css-sf4iut .css-kpahiq p'))
            )
            driver.execute_script("arguments[0].innerText = ''", token_input)
            token_input.send_keys(jwt_token_value)
            
            # Sync
            sync_button = driver.find_element(By.CLASS_NAME, 'css-1rxme48')
            sync_button.click()
            time.sleep(5)  # Wait for sync
            
            return True
        except Exception as e:
            print(f"Scraper Error: {str(e)}")
            if attempt == 2: 
                driver.save_screenshot(f"crash_{obj['slug']}.png")
                raise
            human_like_delay(5, 10)
            driver.save_screenshot(f"error_{obj.get('slug', 'unknown')}.png")
            sys.exit(1)
            raise
def main():
    parser = ArgumentParser(description='Automated API Documentation Updater')
    parser.add_argument('--token', required=True, help='JWT authentication token')
    parser.add_argument('--sftp-uri', required=True, help='SFTP connection URI')
    args = parser.parse_args()

    try:
        with SFTPManager(args.sftp_uri) as sftp:
            # Load data files
            current_data = sftp.get_json('datas_description.json')
            
            try:
                backup_data = sftp.get_json('datas_description_backup.json')
            except FileNotFoundError:
                backup_data = []
                sftp.put_json(backup_data, 'datas_description_backup.json')

            # Find new entries
            new_entries = [entry for entry in current_data if entry not in backup_data]
            if not new_entries:
                return

            # Configure browser
            options = webdriver.ChromeOptions()
            # Realistic User-Agent (Example Chrome on Windows - ADJUST)
            user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            options.add_argument(f'--user-agent={user_agent}')
            options.add_argument('--disable-blink-features=AutomationControlled') # Try to hide automation
            options.add_argument('--window-size=1920,1080')
            options.add_argument('--disable-dev-shm-usage')
            # options.add_argument('--headless=new') # Keep non-headless for debugging
            # options.add_argument('--start-maximized')
            # options.add_argument('--disable-gpu')
            # options.add_argument('--no-sandbox')
            
            with webdriver.Chrome(options=options) as driver:
                success = True
                driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
                browser_cookies = [{"domain": ".rapidapi.com", "expirationDate": 1738669292.498025, "hostOnly": False, "httpOnly": True, "name": "__cf_bm", "path": "/", "sameSite": "no_restriction", "secure": True, "session": False, "storeId": "0", "value": "bA92cLBkyACSCGyKK9GromgqMunm.U8ESr_yinF2Zn8-1738667492-1.0.1.1-pMuwmgkzZGqrx1bqh0OWWF8T.29o8kD_XWdG2gbMCcVpZ0oqGVaABkK_vUGRjJqeqgxQxdmCwW8SdPJvNSEN_A", "id": 1}, {"domain": ".rapidapi.com", "expirationDate": 1770060339, "hostOnly": False, "httpOnly": False, "name": "__stripe_mid", "path": "/", "sameSite": "strict", "secure": True, "session": False, "storeId": "0", "value": "bc69cede-d4bd-4134-b03e-b0f3842fc1f5124f2d", "id": 2}, {"domain": "rapidapi.com", "expirationDate": 1738693435.104652, "hostOnly": True, "httpOnly": True, "name": "__cflb", "path": "/", "sameSite": "no_restriction", "secure": True, "session": False, "storeId": "0", "value": "02DiuHPSNb326nZUQB6NoY4qqsJaLefLQDdmUbd9h9vuA", "id": 3}, {"domain": "rapidapi.com", "expirationDate": 1768941613.632315, "hostOnly": True, "httpOnly": True, "name": "__variation__FF_SearchInput_PlaceHolder", "path": "/", "sameSite": "unspecified", "secure": False, "session": False, "storeId": "0", "value": "0.46", "id": 4}]  # Remaining cookies follow same pattern...
                local_storage_items = {"RapidGuidingSteps": '{"org-default:10143031":{"currentFlow":"FLOW_TO_DO_LIST_MODAL:addInternalAPIs","lastStep":0,"timestamp":1738253257924}}',
                    "SOURCE_LOGIN": "local",
                    "__anon_id": '"a938897d-6f54-4b8e-b853-69d5168e64ab"',
                    "__ff.visitorStickyTrackId": "b921a94b-36d2-4b6f-ab95-8def809c9c4f",
                    "__user_id": '"678eb4d6830d9f001856bfe6"',
                    "__user_traits": '{"email":"newalgeria.org@gmail.com","name":"Newalgeria","username":"Newalgeria"}',
                    "_grecaptcha": "09AGVEItfr8kCZo_S-dMPmM5OeA5q5F_f4z3ktP3Bn3bB8nsPC2AGt5_QvykbeMkamoKOuc-foc7ABM6QWLH3UoUMFHGWM5lHrHeBrdBTHwmuffns0v484IEsW0aP9Ovjc",
                    "build-lastSelectedApp-v1": '"client"',
                    "build-lastSelectedAppPerProject-v1": '{"api_22dd3f3e-f11a-494c-a080-228eb6f67e8c":"client"}',
                    "build-projects-selected-team": '{"selectedTeam":"10143032"}',
                    "build-root-sidebar-collapsed": "true",
                    "build-root-theme": "light",
                    "hide-healthcheck-testing-banner": "true",
                    "ld:$anonUserId": "bfd582b1-d76e-11ef-ad24-e14b209a64e6",
                    "ld:62824a89e7089d15a6f85aa4:$diagnostics": '{"dataSinceDate":1738744506474,"droppedEvents":0,"eventsInLastBatch":0,"streamInits":[]}',
                    "ld:62824a89e7089d15a6f85aa4:eyJraW5kIjoidXNlciIsImtleSI6IjEwMDk5ODEyIiwiYW5vbnltb3VzIjpmYWxzZSwibmFtZSI6Ik5ld2FsZ2VyaWEiLCJlbWFpbCI6Im5ld2FsZ2VyaWEub3JnQGdtYWlsLmNvbSIsImRvbWFpbiI6Imh0dHBzOi8vcmFwaWRhcGkuY29tIiwidGVuYW50VHlwZSI6ImZyZWUifQ==": '{"access_provisioning":{"flagVersion":55,"trackEvents":false,"value":true,"variation":0,"version":274},"admin_overview_navigation":{"flagVersion":7,"trackEvents":false,"value":false,"variation":1,"version":274},"admin_traffic_analytics_filters":{"flagVersion":17,"trackEvents":false,"value":true,"variation":0,"version":274},"admins_builders_widgets_dashboard":{"flagVersion":14,"trackEvents":false,"value":true,"variation":0,"version":274},"allow_proxy_test_endpoint":{"flagVersion":53,"trackEvents":false,"value":false,"variation":1,"version":274},"analytics_get_api_call_payload_from_clickhouse":{"flagVersion":22,"trackEvents":false,"value":true,"variation":0,"version":274},"api-analytics-page-logs-and-filters":{"flagVersion":5,"trackEvents":false,"value":true,"variation":0,"version":274},"api-gateways-redesign":{"flagVersion":5,"trackEvents":false,"value":true,"variation":0,"version":274},"api_healthcheck_testing_banner":{"flagVersion":5,"trackEvents":false,"value":true,"variation":0,"version":274}}',
                    "ld:62824a89e7089d15a6f85aa4:eyJraW5kIjoidXNlciIsImtleSI6IjEwMDk5ODEyIiwiZW1haWwiOiJuZXdhbGdlcmlhLm9yZ0BnbWFpbC5jb20iLCJuYW1lIjoiTmV3YWxnZXJpYSIsImRvbWFpbiI6Imh0dHBzOi8vcmFwaWRhcGkuY29tIiwidGVuYW50VHlwZSI6ImZyZWUifQ==": '{"pub-hub-subscription-survey":{"version":272,"flagVersion":4,"value":2,"variation":1,"trackEvents":false},"build_alerts":{"version":272,"flagVersion":11,"value":true,"variation":0,"trackEvents":false},"ip-access-control-redesign":{"version":272,"flagVersion":5,"value":true,"variation":0,"trackEvents":false},"hub_response_extensions":{"version":272,"flagVersion":8,"value":false,"variation":1,"trackEvents":false},"new_analytics_admin_dashboard":{"version":272,"flagVersion":47,"value":true,"variation":0,"trackEvents":false},"show_alerts_feature":{"version":272,"flagVersion":16,"value":true,"variation":0,"trackEvents":false},"search_insights":{"version":272,"flagVersion":6,"value":false,"variation":1,"trackEvents":false},"audits-console":{"version":272,"flagVersion":4,"value":false,"variation":1,"trackEvents":false},"project_butterfly_non_marketing":{"version":272,"flagVersion":5,"value":false,"variation":1,"trackEvents":false},"improved_inbox":{"version":272,"flagVersion":12,"value":true,"variation":0,"trackEvents":false}}',
                    "ld:62824a89e7089d15a6f85aa4:eyJraW5kIjoidXNlciIsImtleSI6IjEwMDk5ODEyIiwiZW1haWwiOiJuZXdhbGdlcmlhLm9yZ0BnbWFpbC5jb20iLCJuYW1lIjoiTmV3YWxnZXJpYSIsImRvbWFpbiI6bnVsbCwidGVuYW50VHlwZSI6ImZyZWUifQ==": '{"new_tags_page":{"version":274,"flagVersion":5,"value":true,"variation":0,"trackEvents":false},"graphql_documentation":{"version":274,"flagVersion":27,"value":true,"variation":0,"trackEvents":false},"pub-hub-subscription-survey":{"version":274,"flagVersion":4,"value":2,"variation":1,"trackEvents":false},"unified_masthead":{"version":274,"flagVersion":142,"value":true,"variation":0,"trackEvents":false},"project_butterfly_non_marketing":{"version":274,"flagVersion":5,"value":false,"variation":1,"trackEvents":false},"search_insights":{"version":274,"flagVersion":6,"value":false,"variation":1,"trackEvents":false},"project_butterfly":{"version":274,"flagVersion":49,"value":false,"variation":1,"trackEvents":false},"ip-access-control-redesign":{"version":274,"flagVersion":5,"value":true,"variation":0,"trackEvents":false},"api_project_sharing":{"version":274,"flagVersion":21,"value":false,"variation":1,"trackEvents":false},"butterfly_admin_pricing_plan":{"version":274,"flagVersion":7,"value":false,"variation":1,"trackEvents":false}}',
                    "persist:environments": '{"currentEnvironments":"{}","_persist":"{\\"version\\":1,\\"rehydrated\\":true}"}',
                    "persist:extension": '{"scripts":"[\\"https://luckymarmot-content.s3.amazonaws.com/extensions/code-generator/next/main.js\\",\\"https://luckymarmot-content.s3.amazonaws.com/extensions/openapiv3-exporter/next/main.min.js\\",\\"https://luckymarmot-content.s3.amazonaws.com/extensions/openapiv3-importer/preview/main.min.js\\",\\"https://luckymarmot-content.s3.amazonaws.com/extensions/postman-importer/preview/main.min.js\\"]","_persist":"{\\"version\\":4,\\"rehydrated\\":true}"}',
                    "persist:uiState": '{"tabsState":"{\\"tabSystems\\":{\\"httpExchangeTab/92edd137-015c-441e-b7ac-daa04cd474b6\\":{\\"currentTab\\":\\"response\\"},\\"httpExchangeTab\\":{\\"currentTab\\":\\"response\\"},\\"requestTabs/4b16491c-11b6-468c-b841-03c78261b8cd\\":{\\"currentTab\\":\\"auth\\"},\\"requestTabs\\":{\\"currentTab\\":\\"auth\\"},\\"requestTabs/_pg_apiendpoint_0bd776ba-c9c7-4c0a-8320-4db70f032d11\\":{\\"currentTab\\":\\"auth\\"},\\"httpExchangeTab/c5062877-1187-4844-b9d5-93027eae5de5\\":{\\"currentTab\\":\\"info\\"},\\"httpExchangeTab/c67c601a-8d96-4381-acf8-0ede05a29042\\":{\\"currentTab\\":\\"response\\"},\\"httpExchangeMessageTab-_pg_apiendpoint_7d8f8997-bbe4-46cb-b509-b55cc0fe78f1-response-application%2Fjson\\":{\\"currentTab\\":\\"web\\"},\\"httpExchangeMessageTab-4b16491c-11b6-468c-b841-03c78261b8cd-response-application%2Fjson\\":{\\"currentTab\\":\\"raw\\"},\\"requestTabs/f06f9e2a-bd06-4a22-a4ca-ef11431d6695\\":{\\"currentTab\\":\\"headers\\"},\\"requestTabs/da5812db-a840-498b-8fa8-25f651ea5ed2\\":{\\"currentTab\\":\\"auth\\"}}}","settingsState":"{\\"theme\\":\\"light\\"}"}',
                    "rapidThemeEditorMenuAlign": '"left"',
                    "rapidapi-context": '{"entityId":"10099812","type":"User"}',
                    "state": '{"auth":{"isAuthorized":true,"user":{"email":"newalgeria.org@gmail.com","id":"10099812","username":"Newalgeria","thumbnail":"https://s3.amazonaws.com/rapidapi-prod-user/9071a569-9898-4379-a413-4a9f652cc407","apisCount":2,"name":"Newalgeria","entity":{"id":10099812,"type":"User","status":"ACTIVE","mashapeId":"678eb4d6830d9f001856bfe6","thumbnail":null,"name":"Newalgeria","email":"newalgeria.org@gmail.com","slugifiedName":"Newalgeria","parents":[{"id":10143032,"type":"Team","status":"ACTIVE","mashapeId":"679b62f105714200186163b3","thumbnail":null,"name":"New Algeria-Default","email":"","slugifiedName":"new-algeria-new-algeria-default"}]},"corporateDomain":{"domain":"gmail.com","ignore":true},"organizations":[{"id":"10143031","name":"New Algeria","thumbnail":"/static-assets/default/teamContext.svg","slugifiedName":"new-algeria","teams":[{"id":"10143032"}]}]}}}',
                    "theme": "dark",
                    "tw_init": "1",
                    "twik_store": '{"fsts":1737405454506,"sts":1738701562081,"ts":1738701562081,"fingerprint":"04b44e6f444584c417fb58a78384c993","fpVer":1,"psts":1738524303416}'
                }
                session_storage_items = {"sentryReplaySession": '{"id":"7ea9f5aaac14481f9adc34e497402102","started":1738745171417,"lastActivity":1738745171417,"segmentId":0,"sampled":false,"shouldRefresh":true}', "x-entity-id": "10143032"}
                jwt_token_value = args.token
                for cookie in browser_cookies:
                    if cookie['name'] == 'jwt_auth':
                        jwt_token_value = cookie['value']
                        break
                if not jwt_token_value:
                    print("Warning: jwt_auth cookie not found in provided cookies.")
                for idx, entry in enumerate(new_entries, 1):
                    try:
                        print(f"Processing {entry['slug']} ({idx}/{len(new_entries)})")
                        if not process_object(driver, entry, browser_cookies, local_storage_items, session_storage_items, jwt_token_value):
                            success = False
                            break
                    except Exception as e:
                        print(f"Failed processing {entry['slug']}: {str(e)}")
                        success = False
                        break

                if success:
                    updated_backup = backup_data + new_entries
                    sftp.put_json(updated_backup, 'datas_description_backup.json')
                    print("Successfully updated backup")
                else:
                    print("Aborting backup update due to failures")

    except Exception as e:
        print(f"Critical failure: {str(e)}")
        sys.exit(1)

if __name__ == '__main__':
    main()`