import json
import os
import sys
import time
import paramiko
import logging
from argparse import ArgumentParser
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.wait import WebDriverWait
from urllib.parse import urlparse
from pathlib import Path

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

def process_object(driver, obj, token):
    """Enhanced with explicit waits and error recovery"""
    # try:
    #     driver.get('https://rapidapi.com/studio/api_22dd3f3e-f11a-494c-a080-228eb6f67e8c/client/4b16491c-11b6-468c-b841-03c78261b8cd')
    #     driver.add_cookie({'name': 'token','value': token,'domain': urlparse(driver.current_url).hostname})
    #     driver.add_cookie({'name': 'jwt_auth', 'value': token,'domain': urlparse(driver.current_url).hostname})
    #     driver.refresh()

    #     # Add explicit waits for critical elements
    #     WebDriverWait(driver, 15).until(
    #         EC.presence_of_element_located((By.CSS_SELECTOR, 'div.css-vyrhqs.css-1lfcwor'))
    #     )
        
    #     # Click on the div with specific classes
    #     target_div = WebDriverWait(driver, 10).until(
    #         EC.presence_of_element_located((By.XPATH, '//div[contains(@class, "css-vyrhqs") and contains(@class, "css-1lfcwor")]'))
    #     )
    #     buttons = target_div.find_elements(By.CLASS_NAME, 'css-1tfwfkp')
    #     if len(buttons) >= 2:
    #         buttons[1].click()
        
    #     time.sleep(4)  # Wait for page load
        
    #     # Click on API endpoint div
    #     endpoint_div = driver.find_element(By.CLASS_NAME, 'elrb9vu0.css-1992qbr')
    #     endpoint_div.click()
        
    #     # Enter API endpoint URL
    #     endpoint_input = driver.find_element(By.CLASS_NAME, 'css-d4v849')
    #     endpoint_input.clear()
    #     endpoint_input.send_keys(f'https://api.dz.com/api/{obj["slug"]}')
    """Robust element handling with improved error reporting"""
    try:
        # Initialize browser with proper configuration
        driver.set_window_size(1920, 1080)
        driver.implicitly_wait(10)

        # Navigate to base domain first for cookies
        base_url = 'https://rapidapi.com'
        driver.get(base_url)
        
        # Add cookies to the correct domain
        cookie_domain = urlparse(base_url).hostname
        driver.add_cookie({'name': 'token', 'value': token, 'domain': cookie_domain})
        driver.add_cookie({'name': 'jwt_auth', 'value': token, 'domain': cookie_domain})

        # Navigate to target URL
        target_url = 'https://rapidapi.com/studio/api_22dd3f3e-f11a-494c-a080-228eb6f67e8c/client/4b16491c-11b6-468c-b841-03c78261b8cd'
        driver.get(target_url)

        # Wait for page load using ready state
        WebDriverWait(driver, 20).until(
            lambda d: d.execute_script('return document.readyState') == 'complete'
        )

        # Improved element interaction sequence
        # -----------------------------------------------------------
        # 1. Find container with combined class check
        container = WebDriverWait(driver, 15).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, 'div.css-vyrhqs.css-1lfcwor'))
        )
        
        # 2. Click second button using XPath index
        buttons = container.find_elements(By.XPATH, './/button[contains(@class, "css-1tfwfkp")]')
        if len(buttons) >= 2:
            WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable(buttons[1])
            ).click()
        
        # 3. Wait for animation/load
        time.sleep(2)  # Consider replacing with explicit wait if possible
        
        # 4. API endpoint interaction
        endpoint_section = WebDriverWait(driver, 10).until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, 'div.elrb9vu0.css-1992qbr'))
        )
        endpoint_section.click()
        
        # 5. Input handling with clear and retry
        endpoint_input = WebDriverWait(driver, 10).until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, 'input.css-d4v849'))
        )
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
        token_input.send_keys(token)
        
        # Sync
        sync_button = driver.find_element(By.CLASS_NAME, 'css-1rxme48')
        sync_button.click()
        time.sleep(5)  # Wait for sync
        
        return True
    except Exception as e:
        print(f"SFTP Error: {str(e)}")
        sys.exit(1)
    except Exception as e:
        driver.save_screenshot(f"error_{obj.get('slug', 'unknown')}.png")
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
                print("No new entries to process")
                return

            # Configure browser
            options = webdriver.ChromeOptions()
            options.add_argument('--headless=new')
            options.add_argument('--disable-gpu')
            options.add_argument('--no-sandbox')
            options.add_argument('--disable-dev-shm-usage')
            options.add_argument('--disable-blink-features=AutomationControlled')
            options.add_argument('--window-size=1920,1080')
            
            with webdriver.Chrome(options=options) as driver:
                success = True
                for idx, entry in enumerate(new_entries, 1):
                    try:
                        print(f"Processing {entry['slug']} ({idx}/{len(new_entries)})")
                        if not process_object(driver, entry, args.token):
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
    main()