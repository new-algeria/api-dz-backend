import os
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

# Configure logging (unchanged)
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

def human_type(element, text, delay=(0.1, 0.5)):
    """Simulate human typing with random delays between keystrokes"""
    ActionChains(element._parent).move_to_element(element).click().perform()
    for char in text:
        element.send_keys(char)
        time.sleep(random.uniform(*delay))

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

def perform_login(driver, email, password):
    """Handle login flow with human-like interactions"""
    driver.get("https://rapidapi.com/studio")
    
    # Wait for login page to load
    WebDriverWait(driver, 10).until(
        EC.presence_of_element_located((By.ID, "login-form_email")))
    
    # Fill email
    email_field = driver.find_element(By.ID, "login-form_email")
    human_type(email_field, email)
    human_like_delay(1, 2)
    
    # Fill password
    password_field = driver.find_element(By.ID, "login-form_password")
    human_type(password_field, password)
    human_like_delay(1, 2)
    
    # Click submit
    submit_btn = WebDriverWait(driver, 10).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, "button[type='submit']")))
    ActionChains(driver).move_to_element(submit_btn).pause(1).click().perform()
    human_like_delay(2, 4)
    
    # Wait for login to complete
    WebDriverWait(driver, 20).until(
        EC.url_contains("studio"))
    human_like_delay(2, 4)  # Additional post-login delay

def process_object(driver, obj, jwt_token):
    """Enhanced processing with robust element handling"""
    for attempt in range(3):
        try:
            # Navigate to target page with extended wait
            driver.get("https://rapidapi.com/studio/api_22dd3f3e-f11a-494c-a080-228eb6f67e8c/client/4b16491c-11b6-468c-b841-03c78261b8cd")
            WebDriverWait(driver, 20).until(
                EC.presence_of_element_located((By.TAG_NAME, 'body')))
            
            # --- Click 'Add' Button with improved detection ---
            try:
                human_like_delay(2, 3)
                add_button = WebDriverWait(driver, 15).until(
                    EC.element_to_be_clickable((By.XPATH, 
                        "//button[.//*[local-name()='svg' and @aria-label='add']]")))
                ActionChains(driver).move_to_element(add_button).pause(0.5).click().perform()
                logging.info("Clicked 'Add' button successfully")
            except Exception as e:
                logging.error(f"Add button error: {str(e)}")
                raise

            # --- Handle Endpoint Input with visibility check ---
            try:
                endpoint_input = WebDriverWait(driver, 15).until(
                    EC.visibility_of_element_located(
                        (By.CSS_SELECTOR, "div.e10vnnfs0.css-1dxvcps[contenteditable='true']")
                    ))
                # Human-like typing simulation
                human_like_delay(1, 2)
                endpoint_input.click()
                for char in f'https://api.dz.com/api/{obj["slug"]}':
                    endpoint_input.send_keys(char)
                    time.sleep(random.uniform(0.1, 0.3))
                logging.info("Endpoint input filled successfully")
            except Exception as e:
                logging.error(f"Endpoint input error: {str(e)}")
                raise

            # --- Description Button with case-insensitive search ---
            try:
                desc_button = WebDriverWait(driver, 15).until(
                    EC.element_to_be_clickable((By.XPATH,
                        "//button[.//div[contains(translate(text(), 'DESCRIPTION', 'description'), 'description')]]")))
                ActionChains(driver).move_to_element(desc_button).pause(0.5).click().perform()
                logging.info("Description button clicked")
            except Exception as e:
                logging.error(f"Description button error: {str(e)}")
                raise
            
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
            token_input.send_keys(jwt_token)
            
            # Sync
            sync_button = driver.find_element(By.CLASS_NAME, 'css-1rxme48')
            sync_button.click()
            time.sleep(5)  # Wait for sync
            
            return True
        except Exception as e:
            logging.error(f"Scraper Error: {str(e)}")
            if attempt == 2: 
                driver.save_screenshot(f"crash_{obj['slug']}.png")
                raise
            human_like_delay(5, 10)
            driver.refresh()
def main():
    parser = ArgumentParser(description='Automated API Documentation Updater')
    parser.add_argument('--mail', required=True, help='Login email')
    parser.add_argument('--password', required=True, help='Login password')
    parser.add_argument('--sftp-uri', required=True, help='SFTP connection URI')
    parser.add_argument('--token', required=True, help='JWT token for API requests')
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
                driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
                # Perform login instead of cookie injection
                perform_login(driver, args.mail, args.password)
                
                success = True
                for idx, entry in enumerate(new_entries, 1):
                    try:
                        logging.info(f"Processing {entry['slug']} ({idx}/{len(new_entries)})")
                        if not process_object(driver, entry, args.token):
                            success = False
                            break
                    except Exception as e:
                        logging.error(f"Failed processing {entry['slug']}: {str(e)}")
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